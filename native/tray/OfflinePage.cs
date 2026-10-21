// The bundled offline page (HOST-CONTROL-PAGE.md 5.8, frame host-12). Shown while
// the host is starting or after it stopped, since /host can't load then.
using System.Net;

namespace WinDock.Tray;

internal enum OfflineVariant { Starting, Slow, PortInUse, Exited }

internal static class OfflinePage
{
    /// <summary>Served by WebResourceRequested; never reaches the network.</summary>
    internal const string Origin = "https://offline.windock.invalid";

    internal static string Render(OfflineVariant variant, int port, string detail)
    {
        var stopped = variant is OfflineVariant.PortInUse or OfflineVariant.Exited;
        var (title, body) = variant switch
        {
            OfflineVariant.Starting => ("Starting WinDock…", ""),
            OfflineVariant.Slow => ("WinDock is taking a while to start", "Check the logs if this keeps happening."),
            OfflineVariant.PortInUse => ($"Port {port} is in use", "Another app, or another copy of WinDock, is using it. Close that app, then try again."),
            _ => ("WinDock stopped unexpectedly", "Phones can't connect until it's running again."),
        };
        const string retry = "<button class=\"btn primary\" data-msg=\"restart\">Try again</button>";
        const string restart = "<button class=\"btn primary\" data-msg=\"restart\">Restart</button>";
        const string logs = "<button class=\"btn\" data-msg=\"openLogs\"><svg class=\"i\" viewBox=\"0 0 24 24\"><path d=\"M6.5 3.5h7l4 4v13h-11z\"/><path d=\"M13.5 3.5v4h4M9 12h6M9 15.5h6\"/></svg>Open logs</button>";
        var actions = variant switch
        {
            OfflineVariant.Starting => "",
            OfflineVariant.Slow => logs + retry,
            OfflineVariant.PortInUse => retry + logs,
            _ => restart + logs,
        };
        var chip = stopped
            ? "<span class=\"chip bad\"><span class=\"dot\"></span>Stopped</span>"
            : "<span class=\"chip idle\"><span class=\"dot\"></span>Starting</span>";
        var glyph = stopped
            ? "<span class=\"gl\"><svg class=\"i\" viewBox=\"0 0 24 24\"><path d=\"M12 3.5v7\"/><path d=\"M7.2 6.6a7.5 7.5 0 1 0 9.6 0\"/></svg></span>"
            : "";
        var detailHtml = stopped && detail.Length > 0
            ? $"<div class=\"group\"><p class=\"cap mono\">{WebUtility.HtmlEncode(detail)}</p></div>" : "";
        var bodyHtml = body.Length > 0 ? $"<p class=\"p\">{WebUtility.HtmlEncode(body)}</p>" : "";
        var foot = stopped ? "<p class=\"cap foot\">Phones can’t connect until WinDock is running.</p>" : "";
        var actionsHtml = actions.Length > 0 ? $"<div class=\"btns\">{actions}</div>" : "";

        return $$"""
<!doctype html>
<html lang="en" data-os="windows"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WinDock</title>
<style>
:root{--bg:#090E10;--row:#13191B;--menu:#1A2224;--text:#EEF3F1;--text-2:#A0AFAF;--text-3:#7D8C8E;--accent:#82E8BF;--on-accent:#0A1C1A;
--danger-text:#F1AAA6;--danger-tint:rgba(237,150,149,.12);--line-strong:rgba(255,255,255,.12);--rc:4px;--rg:8px;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI Variable Text","Segoe UI",sans-serif}
body{background:radial-gradient(120% 60% at 0 0,rgba(74,108,83,.26),transparent 60%) var(--bg);overflow:auto}
svg.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.head{display:flex;align-items:center;gap:8px;height:48px;padding:0 8px 0 16px;position:relative}
.brand{display:flex;align-items:center;gap:8px;font-weight:600}
.mark{display:grid;grid-template-columns:1fr 1fr;gap:16%;width:18px;height:18px}
.mark i{border-radius:22%}.mark i:nth-child(1){background:#82E8BF}.mark i:nth-child(2){background:#C7FAE8}
.mark i:nth-child(3){background:#80BAFF}.mark i:nth-child(4){background:#69D9CC}
.chip{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:11px;font-size:12px;font-weight:600}
.chip .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.bad{background:var(--danger-tint);color:var(--danger-text)}.chip.idle{background:rgba(255,255,255,.06);color:var(--text-2)}
.ib{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:var(--rc);color:var(--text-2);background:none;border:0;cursor:pointer}
.ib:hover,.ib[aria-expanded=true]{background:rgba(255,255,255,.08);color:var(--text)}
.menu{position:absolute;right:8px;top:44px;min-width:200px;background:var(--menu);border:1px solid var(--line-strong);border-radius:var(--rg);padding:4px;display:none;z-index:2}
.menu.open{display:block}
.menu button{display:block;width:100%;height:32px;text-align:left;padding:0 12px;border:0;border-radius:var(--rc);background:none;color:var(--text);font:inherit;cursor:pointer}
.menu button:hover,.menu button:focus-visible{background:rgba(255,255,255,.08);outline:none}
.body{padding:12px 16px 16px}
.gl{display:grid;place-items:center;width:40px;height:40px;border-radius:var(--rg);background:var(--danger-tint);color:var(--danger-text);margin-bottom:14px}
.gl svg.i{width:20px;height:20px}
.t{font-size:16px;font-weight:600;line-height:1.3;margin:0}
.p{color:var(--text-2);margin:4px 0 0}
.group{background:var(--row);border-radius:var(--rg);padding:10px 12px;margin-top:14px}
.cap{font-size:12px;color:var(--text-3);margin:0;line-height:1.4}
.mono{font:13px/1.4 "Cascadia Mono",Consolas,monospace;color:var(--text-2);overflow-wrap:anywhere}
.btns{display:flex;gap:8px;margin-top:16px}
.btn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:var(--rc);border:1px solid transparent;
background:rgba(255,255,255,.08);color:var(--text);font:600 14px "Segoe UI Variable Text","Segoe UI",sans-serif;cursor:pointer}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn:focus-visible,.ib:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{margin-top:16px}
@media (pointer:coarse){.btn,.ib,.menu button{min-height:44px} }
</style></head>
<body>
<main id="root">
<div class="head">
  <div class="brand"><div class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>WinDock</div>
  {{chip}}
  <button class="ib" id="more" aria-label="More" aria-haspopup="menu" aria-expanded="false"><svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg></button>
  <div class="menu" id="menu" role="menu">
    <button role="menuitem" data-msg="openLogs">Open logs folder</button>
    <button role="menuitem" data-msg="quit">Quit WinDock</button>
  </div>
</div>
<div class="body">
  {{glyph}}
  <p class="t" role="status">{{WebUtility.HtmlEncode(title)}}</p>
  {{bodyHtml}}
  {{detailHtml}}
  {{actionsHtml}}
  {{foot}}
</div>
</main>
<script>
(function(){
  var post=function(m){ if(window.chrome&&chrome.webview) chrome.webview.postMessage(m); };
  var more=document.getElementById('more'), menu=document.getElementById('menu');
  function setMenu(open){ menu.classList.toggle('open',open); more.setAttribute('aria-expanded',String(open)); if(open) menu.querySelector('button').focus(); }
  more.addEventListener('click',function(e){ e.stopPropagation(); setMenu(!menu.classList.contains('open')); });
  document.addEventListener('click',function(){ setMenu(false); });
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape') return;
    if(menu.classList.contains('open')){ setMenu(false); more.focus(); } else post({type:'close'});
  });
  document.querySelectorAll('[data-msg]').forEach(function(b){ b.addEventListener('click',function(){ post({type:b.getAttribute('data-msg')}); }); });
  function size(){ post({type:'resize',height:Math.ceil(document.getElementById('root').getBoundingClientRect().height)}); }
  post({type:'ready'}); size(); window.addEventListener('resize',size);
})();
</script>
</body></html>
""";
    }
}
