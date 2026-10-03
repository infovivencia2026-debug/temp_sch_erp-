package com.schoolerp.parent

import android.app.Activity
import android.app.NotificationManager
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebResourceResponse
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/* THE PHONE'S HALF OF window.ErpShell, VERSION 2 (docs/native-shell.md).

   MainActivity's Shell object is what the page sees; each version-2 method
   there is one line that lands here. Like the rest of this app it uses the
   platform only: Android Keystore, JobScheduler, HttpURLConnection,
   DownloadManager-free plain HTTP, no AndroidX.

   Everything on disk is in the app's private directory:
     store.key.enc   the offline store's key, sealed by a Keystore AES key
     outbox.json     the page's waiting writes, sent by OutboxJob
     offline/        lesson files and videos saved for offline
   Saved files are shown to the page at https://offline.xulo.invalid/<hash>,
   answered from disk by MainActivity's shouldInterceptRequest. */
object Native {
    const val OFFLINE_HOST = "offline.xulo.invalid"
    const val REQUEST_PICK = 1101
    private const val KEY_ALIAS = "xulo-store"
    private const val MAX_FILE = 20 * 1024 * 1024

    /* ---- the offline store's key ------------------------------------- */

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    /** 32 random bytes, base64, kept sealed by a key that never leaves the Keystore. */
    fun storeKey(ctx: Context): String? = runCatching {
        val f = File(ctx.filesDir, "store.key.enc")
        if (f.exists()) {
            val all = f.readBytes()
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, all.copyOfRange(0, 12)))
            return@runCatching Base64.encodeToString(c.doFinal(all.copyOfRange(12, all.size)), Base64.NO_WRAP)
        }
        val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, keystoreKey())
        f.writeBytes(c.iv + c.doFinal(raw))
        Base64.encodeToString(raw, Base64.NO_WRAP)
    }.getOrNull()

    /** A remote sign-out: everything this app kept for the person. */
    fun wipe(ctx: Context) {
        File(ctx.filesDir, "store.key.enc").delete()
        File(ctx.filesDir, "outbox.json").delete()
        offlineDir(ctx).deleteRecursively()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS) }
        (ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler)?.cancel(OutboxJob.ID)
    }

    /* ---- badge ---------------------------------------------------------- */

    /* Android launchers draw the dot or count from this app's notifications
       (PushService posts them on a channel with showBadge). There is no
       platform call to set a number without a notification, so the page's
       count can only clear it: nothing unread, nothing in the shade. */
    fun setBadge(ctx: Context, n: Int) {
        if (n <= 0) (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancelAll()
    }

    /* ---- the school (generic app) -------------------------------------- */

    fun savedSchool(ctx: Context): JSONObject? = runCatching {
        val s = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE).getString("school", null) ?: return null
        JSONObject(s).takeIf { it.optString("portal_url").startsWith("https://") }
    }.getOrNull()

    fun saveSchool(ctx: Context, json: String): String? = runCatching {
        val o = JSONObject(json)
        val url = o.getString("portal_url")
        if (!url.startsWith("https://")) return null
        ctx.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putString("school", o.toString()).apply()
        url
    }.getOrNull()

    fun forgetSchool(ctx: Context) {
        ctx.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().remove("school").apply()
    }

    fun schoolSummary(ctx: Context): String? = savedSchool(ctx)?.let {
        JSONObject().put("code", it.optString("code")).put("name", it.optString("name"))
            .put("host", Uri.parse(it.optString("portal_url")).host).toString()
    }

    /* ---- events to the page -------------------------------------------- */

    fun emit(web: WebView?, detail: JSONObject) {
        web ?: return
        web.post {
            web.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('erp-shell',{detail:$detail}))", null,
            )
        }
    }

    /* ---- files: picked, shared ----------------------------------------- */

    fun fileJson(ctx: Context, uri: Uri): JSONObject? = runCatching {
        var name = "file"
        var size = -1L
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst()) {
                name = it.getString(0) ?: name
                size = if (it.isNull(1)) -1 else it.getLong(1)
            }
        }
        if (size > MAX_FILE) return null
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        if (bytes.size > MAX_FILE) return null
        JSONObject().put("name", name)
            .put("type", ctx.contentResolver.getType(uri) ?: "application/octet-stream")
            .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    }.getOrNull()

    /** Images and PDFs shared into the app from another app's share sheet. */
    @Suppress("DEPRECATION") // the typed getParcelable overloads are API 33; minSdk is 24
    fun sharedFiles(ctx: Context, intent: Intent?): JSONObject? {
        intent ?: return null
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else -> return null
        }
        val files = JSONArray()
        uris.take(10).mapNotNull { fileJson(ctx, it) }.forEach { files.put(it) }
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (files.length() == 0 && text == null) return null
        return JSONObject().put("type", "share").put("files", files).apply { if (text != null) put("text", text) }
    }

    /** Starts the picker; MainActivity.onActivityResult hands the answer to [picked]. */
    var pendingPick: Pair<String, Uri?>? = null

    fun pickFile(activity: Activity, id: String, kind: String, accept: String) {
        val intent = when (kind) {
            /* There is no document scanner in the platform; the camera takes
               the page. A scanner (ML Kit) would bring Google Play services
               into an app that otherwise needs none. */
            "camera", "scan" -> {
                val out = PickedFileProvider.newImageUri(activity)
                pendingPick = id to out
                Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(android.provider.MediaStore.EXTRA_OUTPUT, out)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            else -> {
                pendingPick = id to null
                Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(accept.split(',').firstOrNull()?.trim()?.ifEmpty { null } ?: "*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
        activity.runOnUiThread {
            runCatching { activity.startActivityForResult(intent, REQUEST_PICK) }
                .onFailure { pendingPick = null }
        }
    }

    fun picked(activity: Activity, ok: Boolean, data: Intent?, web: WebView?) {
        val (id, capture) = pendingPick ?: return
        pendingPick = null
        val uris = when {
            !ok -> emptyList()
            data?.clipData != null -> (0 until data.clipData!!.itemCount).map { data.clipData!!.getItemAt(it).uri }
            data?.data != null -> listOf(data.data!!)
            capture != null -> listOf(capture)
            else -> emptyList()
        }
        Thread {
            val files = JSONArray()
            uris.take(10).mapNotNull { fileJson(activity, it) }.forEach { files.put(it) }
            emit(web, JSONObject().put("type", "picked").put("id", id).put("files", files))
        }.start()
    }

    /* ---- files saved for offline --------------------------------------- */

    private fun offlineDir(ctx: Context) = File(ctx.filesDir, "offline").apply { mkdirs() }
    private fun hash(url: String) =
        MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).take(16).joinToString("") { "%02x".format(it) }

    fun downloaded(ctx: Context, url: String): String? =
        if (File(offlineDir(ctx), hash(url)).exists()) "https://$OFFLINE_HOST/${hash(url)}" else null

    fun removeDownload(ctx: Context, url: String) {
        File(offlineDir(ctx), hash(url)).delete()
    }

    /** Fetched with the WebView's session cookie, in a background thread. */
    fun download(ctx: Context, id: String, url: String, web: WebView?) {
        Thread {
            val target = File(offlineDir(ctx), hash(url))
            val ok = runCatching {
                val c = URL(url).openConnection() as HttpURLConnection
                CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
                c.connectTimeout = 20_000
                c.readTimeout = 60_000
                if (c.responseCode !in 200..299) error("status ${c.responseCode}")
                val tmp = File(target.path + ".part")
                c.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                File(target.path + ".type").writeText(c.contentType ?: "application/octet-stream")
                tmp.renameTo(target)
            }.isSuccess
            emit(web, JSONObject().put("type", "downloaded").put("id", id).put("url", url).put("ok", ok)
                .apply { if (ok) put("local", "https://$OFFLINE_HOST/${hash(url)}") })
        }.start()
    }

    /** MainActivity.shouldInterceptRequest: a saved file, or null. */
    fun serve(ctx: Context, uri: Uri): WebResourceResponse? {
        if (uri.host != OFFLINE_HOST) return null
        val name = uri.lastPathSegment ?: return null
        if (!Regex("^[0-9a-f]{32}$").matches(name)) return null
        val f = File(offlineDir(ctx), name)
        if (!f.exists()) return WebResourceResponse("text/plain", "utf-8", 404, "Not saved", emptyMap(), null)
        val type = runCatching { File(f.path + ".type").readText() }.getOrDefault("application/octet-stream")
        return WebResourceResponse(type, null, FileInputStream(f))
    }

    /* ---- the outbox, sent with the app closed -------------------------- */

    fun outboxChanged(ctx: Context, json: String, origin: String) {
        runCatching {
            val rows = JSONArray(json)
            val keep = JSONArray()
            for (i in 0 until rows.length()) {
                val r = rows.getJSONObject(i)
                if (!r.optString("path").startsWith("/api/")) continue
                keep.put(JSONObject().put("key", r.getString("key")).put("method", r.getString("method"))
                    .put("path", r.getString("path")).put("body", r.optString("body", "")))
            }
            File(ctx.filesDir, "outbox.json").writeText(JSONObject().put("origin", origin).put("rows", keep).toString())
            val js = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            if (keep.length() == 0) { js.cancel(OutboxJob.ID); return }
            js.schedule(
                JobInfo.Builder(OutboxJob.ID, ComponentName(ctx, OutboxJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(false)
                    .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .build(),
            )
        }
    }
}

/* Sends the page's waiting writes when the phone has a network, oldest first,
   with the same Idempotency-Key the page minted. The page replays them again
   when it next opens and the server answers with what it stored, so a write
   never happens twice (worker/src/idempotency.ts). Stops at the first row with
   no answer or a 5xx and asks to be run again. */
class OutboxJob : JobService() {
    companion object { const val ID = 7301 }

    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            val again = runCatching { send() }.getOrDefault(true)
            jobFinished(params, again)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    /** True when rows are left to send later. */
    private fun send(): Boolean {
        val f = File(filesDir, "outbox.json")
        if (!f.exists()) return false
        val o = JSONObject(f.readText())
        val origin = o.getString("origin")
        val rows = o.getJSONArray("rows")
        var sent = 0
        for (i in 0 until rows.length()) {
            val r = rows.getJSONObject(i)
            val url = origin + r.getString("path")
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = r.getString("method")
            c.connectTimeout = 20_000
            c.readTimeout = 30_000
            CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("Idempotency-Key", r.getString("key"))
            val body = r.optString("body", "")
            val code = runCatching {
                if (body.isNotEmpty()) {
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", "application/json")
                    c.outputStream.use { it.write(body.toByteArray()) }
                }
                c.responseCode
            }.getOrDefault(-1)
            if (code < 0 || code >= 500) break
            sent++
        }
        val left = JSONArray()
        for (i in sent until rows.length()) left.put(rows.get(i))
        f.writeText(o.put("rows", left).toString())
        return left.length() > 0
    }
}
