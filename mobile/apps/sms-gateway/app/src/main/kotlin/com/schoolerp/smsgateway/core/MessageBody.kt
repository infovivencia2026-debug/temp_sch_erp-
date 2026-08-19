package com.schoolerp.smsgateway.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * The text of one SMS.
 *
 * This is a wrapper rather than a bare [String] for one reason: its
 * [toString] is a redaction. Interpolating a body into a log line, a crash
 * report, a `data class` `toString`, or an exception message therefore cannot
 * leak it — the worst that escapes is a length. Getting at the real characters
 * requires calling [expose], which is greppable and appears in exactly two
 * places: the SMS send path and the Room type converter.
 *
 * The lint rule catches the obvious mistakes; this catches the ones nobody
 * thought to write a rule for.
 */
@JvmInline
@Serializable(with = MessageBodySerializer::class)
value class MessageBody(private val raw: String) {

    val length: Int get() = raw.length

    val isBlank: Boolean get() = raw.isBlank()

    /** The actual characters. Two callers only: [SmsSender] and the Room converter. */
    fun expose(): String = raw

    override fun toString(): String = "MessageBody(redacted, length=$length)"
}

object MessageBodySerializer : KSerializer<MessageBody> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("MessageBody", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: MessageBody) =
        encoder.encodeString(value.expose())

    override fun deserialize(decoder: Decoder): MessageBody =
        MessageBody(decoder.decodeString())
}
