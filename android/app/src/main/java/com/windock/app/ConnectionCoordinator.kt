package com.windock.app

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.ExecutorService

/**
 * Opening one saved computer (spec 4.2, 4.3). Two tracks from t = 0: the saved endpoint
 * (direct) and discovery by host ID (fed in through [discovered]). The first verdict wins.
 * After 2.5 s without an answer the status becomes "Looking", after 8 s the Can't reach
 * screen, while direct retries continue with backoff 3, 5, 10, then 15 s.
 */
class ConnectionCoordinator(
    private val io: ExecutorService,
    private val pin: (String) -> String?,
    private val listener: Listener,
) {
    enum class Status { CONNECTING, LOOKING }

    interface Listener {
        fun onStatus(computer: Computer, status: Status)
        /** Open, Mismatch or Pair, with the probe that decided it. */
        fun onVerdict(computer: Computer, verdict: Verdict, probe: Probe)
        /** 8 s without an answer; retries continue and a later verdict still arrives. */
        fun onUnreachable(computer: Computer, failure: ProbeFailure?)
    }

    private val main = Handler(Looper.getMainLooper())
    private var attempt = 0
    var computer: Computer? = null
        private set
    private var startedAt = 0L
    private var lastFailure: ProbeFailure? = null
    private var backoffIndex = 0
    private var reportedUnreachable = false
    private var probing = false
    val failure: ProbeFailure? get() = lastFailure
    val active: Boolean get() = computer != null

    private val looking = Runnable { computer?.let { listener.onStatus(it, Status.LOOKING) } }
    private val unreachable = Runnable {
        val c = computer ?: return@Runnable
        reportedUnreachable = true
        listener.onUnreachable(c, lastFailure)
    }
    private val retry = Runnable { probeDirect() }

    fun open(target: Computer) {
        cancel()
        attempt++
        computer = target
        startedAt = SystemClock.uptimeMillis()
        lastFailure = null
        backoffIndex = 0
        reportedUnreachable = false
        listener.onStatus(target, Status.CONNECTING)
        main.postDelayed(looking, LOOKING_MS)
        main.postDelayed(unreachable, UNREACHABLE_MS)
        probeDirect()
    }

    fun cancel() {
        attempt++
        computer = null
        probing = false
        main.removeCallbacks(looking)
        main.removeCallbacks(unreachable)
        main.removeCallbacks(retry)
    }

    /** Try again / a network change: reset the backoff and probe now. */
    fun retryNow() {
        if (computer == null) return
        backoffIndex = 0
        main.removeCallbacks(retry)
        probeDirect()
    }

    /** A verified discovery result; only its host ID decides whether it is this computer. */
    fun discovered(probe: Probe) {
        val c = computer ?: return
        if (probe.hostId != c.hostId) return
        decide(c, probe)
    }

    private fun probeDirect() {
        val c = computer ?: return
        if (probing) return
        probing = true
        val run = attempt
        io.execute {
            val result = HostClient.probe(c.endpoint)
            main.post {
                if (run != attempt) return@post
                probing = false
                when (result) {
                    is HostClient.Result.Answer -> if (!decide(c, result.probe)) scheduleRetry(ProbeFailure.OTHER)
                    is HostClient.Result.Failed -> {
                        scheduleRetry(result.why)
                        // A refusal or timeout this early is a reason to say we are looking.
                        if (SystemClock.uptimeMillis() - startedAt < LOOKING_MS) {
                            main.removeCallbacks(looking); main.post(looking)
                        }
                    }
                }
            }
        }
    }

    /** Returns false when the answer is not this computer (or unusable) and searching continues. */
    private fun decide(c: Computer, probe: Probe): Boolean {
        return when (val verdict = TrustDecision.forComputer(c, pin(c.hostId), probe)) {
            Verdict.Elsewhere, Verdict.Unusable -> false
            else -> {
                cancel()
                listener.onVerdict(c, verdict, probe)
                true
            }
        }
    }

    private fun scheduleRetry(why: ProbeFailure) {
        lastFailure = why
        val delay = BACKOFF_MS[backoffIndex.coerceAtMost(BACKOFF_MS.size - 1)]
        backoffIndex++
        main.removeCallbacks(retry)
        main.postDelayed(retry, delay)
    }

    companion object {
        const val LOOKING_MS = 2_500L
        const val UNREACHABLE_MS = 8_000L
        private val BACKOFF_MS = longArrayOf(3_000, 5_000, 10_000, 15_000)
    }
}
