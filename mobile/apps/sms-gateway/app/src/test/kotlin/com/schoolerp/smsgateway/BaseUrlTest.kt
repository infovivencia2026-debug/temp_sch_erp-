package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.BaseUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BaseUrlTest {

    @Test
    fun `https is accepted and normalised`() {
        val url = BaseUrl.parse("https://school.example.in/", allowInsecureHttp = false).getOrThrow()
        assertEquals("https://school.example.in", url.value)
        assertEquals(
            "https://school.example.in/api/v1/sms-gateway/outbox",
            url.resolve("/api/v1/sms-gateway/outbox"),
        )
    }

    @Test
    fun `plain http is refused when the build does not allow it`() {
        val result = BaseUrl.parse("http://school.example.in", allowInsecureHttp = false)
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("http"))
    }

    @Test
    fun `plain http is accepted only when explicitly allowed`() {
        val result = BaseUrl.parse("http://192.168.1.9:8091", allowInsecureHttp = true)
        assertTrue(result.isSuccess)
    }

    @Test
    fun `a bare host is refused rather than guessed at`() {
        // Silently prefixing https:// would be friendlier and wrong: the
        // operator would never learn the address they were given is incomplete.
        assertTrue(BaseUrl.parse("school.example.in", allowInsecureHttp = false).isFailure)
    }

    @Test
    fun `an ftp url is refused`() {
        assertTrue(BaseUrl.parse("ftp://school.example.in", allowInsecureHttp = true).isFailure)
    }

    @Test
    fun `an empty address is refused`() {
        assertTrue(BaseUrl.parse("   ", allowInsecureHttp = true).isFailure)
    }

    @Test
    fun `a scheme with no host is refused`() {
        assertTrue(BaseUrl.parse("https://", allowInsecureHttp = false).isFailure)
    }
}
