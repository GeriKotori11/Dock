package com.windock.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper

/**
 * Bonjour browse for `_windock._tcp` with NsdManager. Holds a multicast lock while
 * browsing (many Wi-Fi drivers drop mDNS without one). Resolves one service at a time,
 * because NsdManager refuses concurrent resolves before Android 14. Results are hints:
 * HostScanner probes every endpoint over HTTPS before showing anything.
 */
class NsdDiscovery(context: Context, private val onEndpoint: (name: String, endpoint: String, txt: TxtRecord) -> Unit) {
    private val app = context.applicationContext
    private val nsd = app.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())
    private var lock: WifiManager.MulticastLock? = null
    private var listener: NsdManager.DiscoveryListener? = null
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var generation = 0

    fun start() {
        if (listener != null) return
        val run = ++generation
        lock = try {
            (app.getSystemService(Context.WIFI_SERVICE) as WifiManager).createMulticastLock("windock-bonjour").apply {
                setReferenceCounted(false); acquire()
            }
        } catch (_: Exception) { null }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { if (generation == run) { listener = null; releaseLock() } }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                main.post { if (generation == run) enqueue(info) }
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
        }
        listener = l
        try { nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, l) }
        catch (_: Exception) { listener = null; releaseLock() }
    }

    fun stop() {
        generation++
        listener?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        listener = null
        queue.clear()
        resolving = false
        releaseLock()
    }

    private fun releaseLock() {
        try { lock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        lock = null
    }

    private fun enqueue(info: NsdServiceInfo) {
        if (queue.none { it.serviceName == info.serviceName }) queue.addLast(info)
        next()
    }

    @Suppress("DEPRECATION") // resolveService is the API 24-33 path; it still works on 34.
    private fun next() {
        if (resolving || listener == null) return
        val info = queue.removeFirstOrNull() ?: return
        resolving = true
        val run = generation
        try {
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    main.post {
                        if (generation != run) return@post
                        resolving = false
                        if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE) main.postDelayed({ if (generation == run) enqueue(info) }, 400)
                        next()
                    }
                }
                override fun onServiceResolved(resolved: NsdServiceInfo) {
                    main.post {
                        if (generation != run) return@post
                        resolving = false
                        val txt = TxtRecord.parse(resolved.attributes)
                        txt.endpoint(resolved.host?.hostAddress, resolved.port)?.let { onEndpoint(resolved.serviceName, it, txt) }
                        next()
                    }
                }
            })
        } catch (_: Exception) { resolving = false; main.post { next() } }
    }

    companion object { const val TYPE = "_windock._tcp" }
}
