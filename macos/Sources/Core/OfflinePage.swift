// The bundled offline page (HOST-CONTROL-PAGE.md 5.8, frames host-09/host-12),
// shown while the host is starting or after it stopped, since /host can't load
// then. Same markup as the Windows tray's page, with the macOS font, sizes and
// radii from section 3.4. Served by the app under windock-offline://offline/.
import Foundation

enum OfflineVariant: Equatable {
    case starting
    case slow
    case portInUse
    case exited
    case nodeMissing
}

enum OfflinePage {
    static let contentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"

    static func escape(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    static func copy(_ variant: OfflineVariant, port: Int) -> (title: String, body: String) {
        switch variant {
        case .starting: return ("Starting WinDock…", "")
        case .slow: return ("WinDock is taking a while to start", "Check the logs if this keeps happening.")
        case .portInUse: return ("Port \(port) is in use", "Another app, or another copy of WinDock, is using it. Close that app, then try again.")
        case .exited: return ("WinDock stopped unexpectedly", "Phones can’t connect until it’s running again.")
        case .nodeMissing: return ("Node.js isn’t installed", "WinDock needs Node.js 20 or newer on this Mac. Install it, then restart WinDock.")
        }
    }

    static func isStopped(_ variant: OfflineVariant) -> Bool {
        switch variant {
        case .starting, .slow: return false
        case .portInUse, .exited, .nodeMissing: return true
        }
    }

    static func render(_ variant: OfflineVariant, port: Int, detail: String, container: ShellContainer) -> String {
        let stopped = isStopped(variant)
        let (title, body) = copy(variant, port: port)
        let logsIcon = "<svg class=\"i\" viewBox=\"0 0 24 24\"><path d=\"M6.5 3.5h7l4 4v13h-11z\"/><path d=\"M13.5 3.5v4h4M9 12h6M9 15.5h6\"/></svg>"
        let retry = "<button class=\"btn primary\" data-msg=\"restart\">Try again</button>"
        let restartPrimary = "<button class=\"btn primary\" data-msg=\"restart\">Restart</button>"
        let restartSecondary = "<button class=\"btn\" data-msg=\"restart\">Restart</button>"
        let logs = "<button class=\"btn\" data-msg=\"openLogs\">\(logsIcon)Open logs</button>"
        let getNode = "<button class=\"btn primary\" data-msg=\"getNode\">Get Node.js</button>"
        let actions: String
        switch variant {
        case .starting: actions = ""
        case .slow: actions = logs + retry
        case .portInUse: actions = retry + logs
        case .exited: actions = restartPrimary + logs
        case .nodeMissing: actions = getNode + restartSecondary
        }
        let chip = stopped
            ? "<span class=\"chip bad\"><span class=\"dot\"></span>Stopped</span>"
            : "<span class=\"chip idle\"><span class=\"dot\"></span>Starting</span>"
        let glyph = stopped
            ? "<span class=\"gl\"><svg class=\"i\" viewBox=\"0 0 24 24\"><path d=\"M12 3.5v7\"/><path d=\"M7.2 6.6a7.5 7.5 0 1 0 9.6 0\"/></svg></span>"
            : ""
        let showDetail = stopped && variant != .nodeMissing && !detail.isEmpty
        let detailHtml = showDetail ? "<div class=\"group\"><p class=\"cap mono\">\(escape(detail))</p></div>" : ""
        let bodyHtml = body.isEmpty ? "" : "<p class=\"p\">\(escape(body))</p>"
        let foot = stopped ? "<p class=\"cap foot\">Phones can’t connect until WinDock is running.</p>" : ""
        let actionsHtml = actions.isEmpty ? "" : "<div class=\"btns\">\(actions)</div>"

        return """
<!doctype html>
<html lang="en" data-os="macos" data-container="\(container.rawValue)"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WinDock</title>
<style>
:root{--bg:#090E10;--row:#13191B;--menu:#1A2224;--text:#EEF3F1;--text-2:#A0AFAF;--text-3:#7D8C8E;--accent:#82E8BF;--on-accent:#0A1C1A;
--danger-text:#F1AAA6;--danger-tint:rgba(237,150,149,.12);--line-strong:rgba(255,255,255,.12);--rc:8px;--rg:10px;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;-webkit-font-smoothing:antialiased}
body{background:radial-gradient(120% 60% at 0 0,rgba(74,108,83,.26),transparent 60%) var(--bg);overflow:auto;-webkit-user-select:none;user-select:none;cursor:default}
html[data-container=window] #root{padding-top:28px}
svg.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.head{display:flex;align-items:center;gap:8px;height:48px;padding:0 8px 0 16px;position:relative}
.brand{display:flex;align-items:center;gap:8px;font-weight:600}
.mark{display:grid;grid-template-columns:1fr 1fr;gap:16%;width:18px;height:18px}
.mark i{border-radius:22%}.mark i:nth-child(1){background:#82E8BF}.mark i:nth-child(2){background:#C7FAE8}
.mark i:nth-child(3){background:#80BAFF}.mark i:nth-child(4){background:#69D9CC}
.chip{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:11px;font-size:12px;font-weight:600}
.chip .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.bad{background:var(--danger-tint);color:var(--danger-text)}.chip.idle{background:rgba(255,255,255,.06);color:var(--text-2)}
.ib{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:var(--rc);color:var(--text-2);background:none;border:0;cursor:default}
.ib:hover,.ib[aria-expanded=true]{background:rgba(255,255,255,.08);color:var(--text)}
.menu{position:absolute;right:8px;top:44px;min-width:200px;background:var(--menu);border:1px solid var(--line-strong);border-radius:var(--rg);padding:4px;display:none;z-index:2}
.menu.open{display:block}
.menu button{display:block;width:100%;height:28px;text-align:left;padding:0 10px;border:0;border-radius:calc(var(--rc) - 2px);background:none;color:var(--text);font:inherit;cursor:default}
.menu button:hover,.menu button:focus-visible{background:rgba(255,255,255,.08);outline:none}
.body{padding:12px 16px 16px}
.gl{display:grid;place-items:center;width:40px;height:40px;border-radius:var(--rg);background:var(--danger-tint);color:var(--danger-text);margin-bottom:14px}
.gl svg.i{width:20px;height:20px}
.t{font-size:15px;font-weight:600;line-height:1.3;margin:0}
.p{color:var(--text-2);margin:4px 0 0}
.group{background:var(--row);border-radius:var(--rg);padding:10px 12px;margin-top:14px}
.cap{font-size:12px;color:var(--text-3);margin:0;line-height:1.4}
.mono{font:12px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:var(--text-2);overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
.btns{display:flex;gap:8px;margin-top:16px}
.btn{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:var(--rc);border:1px solid transparent;
background:rgba(255,255,255,.08);color:var(--text);font:600 13px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;cursor:default}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn:focus-visible,.ib:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{margin-top:16px}
@media (prefers-reduced-motion:no-preference){.btn,.ib{transition:background-color .12s}}
</style></head>
<body>
<main id="root">
<div class="head">
  <div class="brand"><div class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>WinDock</div>
  \(chip)
  <button class="ib" id="more" aria-label="More" aria-haspopup="menu" aria-expanded="false"><svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg></button>
  <div class="menu" id="menu" role="menu">
    <button role="menuitem" data-msg="openLogs">Open logs folder</button>
    <button role="menuitem" data-msg="quit">Quit WinDock</button>
  </div>
</div>
<div class="body">
  \(glyph)
  <p class="t" role="status">\(escape(title))</p>
  \(bodyHtml)
  \(detailHtml)
  \(actionsHtml)
  \(foot)
</div>
</main>
<script>
(function(){
  var post=function(m){ try{ window.webkit.messageHandlers.windockShell.postMessage(m); }catch(e){} };
  var more=document.getElementById('more'), menu=document.getElementById('menu');
  function setMenu(open){ menu.classList.toggle('open',open); more.setAttribute('aria-expanded',String(open)); if(open) menu.querySelector('button').focus(); }
  more.addEventListener('click',function(e){ e.stopPropagation(); setMenu(!menu.classList.contains('open')); });
  document.addEventListener('click',function(){ setMenu(false); });
  document.addEventListener('keydown',function(e){
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='w'){ e.preventDefault(); post({type:'close'}); return; }
    if(e.key!=='Escape') return;
    if(menu.classList.contains('open')){ setMenu(false); more.focus(); } else post({type:'close'});
  });
  document.querySelectorAll('[data-msg]').forEach(function(b){ b.addEventListener('click',function(){ post({type:b.getAttribute('data-msg')}); }); });
  function size(){ post({type:'resize',height:Math.ceil(document.getElementById('root').getBoundingClientRect().height)}); }
  post({type:'ready'}); size(); window.addEventListener('resize',size);
})();
</script>
</body></html>
"""
    }
}
