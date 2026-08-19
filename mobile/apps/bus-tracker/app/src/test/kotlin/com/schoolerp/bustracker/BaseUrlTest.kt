package com.schoolerp.bustracker

import com.schoolerp.bustracker.core.BaseUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BaseUrlTest {

    @Test
    fun `https is accepted and the trailing slash is dropped`() {
        val url = BaseUrl.parse("https://school.example.in/", allowInsecureHttp = false).getOrThrow()
        assertEquals("https://school.example.in", url.value)
        assertEquals("https://school.example.in/api/v1/bus-tracker/positions", url.resolve("/api/v1/bus-tracker/positions"))
    }

    @Test
    fun `plain http is refused in a release build`() {
        // The token and a live stream of where a bus full of children is would
        // both travel in clear.
        assertTrue(BaseUrl.parse("http://school.example.in", allowInsecureHttp = false).isFailure)
    }

    @Test
    fun `plain http is allowed only when the build and the operator both permit it`() {
        assertTrue(BaseUrl.parse("http://192.168.1.5:8080", allowInsecureHttp = true).isSuccess)
    }

    @Test
    fun `an address with no scheme is rejected with an example rather than a shrug`() {
        val failure = BaseUrl.parse("school.example.in", allowInsecureHttp = false).exceptionOrNull()
        assertTrue(failure?.message.orEmpty().contains("https://"))
    }

    @Test
    fun `an empty host is rejected`() {
        assertTrue(BaseUrl.parse("https://", allowInsecureHttp = false).isFailure)
    }
}
