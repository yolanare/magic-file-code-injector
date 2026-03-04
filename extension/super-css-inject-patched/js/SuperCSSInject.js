(() => {
    'use strict';
    const e = chrome || browser;
    const l = 'data-supercssinject-base-href';
    let n,
        t = 0,
        o = !1;
    function a(e) {
        const n = new URL(e, window.location.href);
        return (n.searchParams.delete('supercssinject_reload'), n.toString());
    }
    function c(e) {
        const n = a(e);
        const t = document.querySelectorAll('link.SuperCSSInject');
        for (const e of t) a(e.href) === n && e.remove();
    }
    function r(e) {
        const n = (function (e) {
            const n = document.createElement('link');
            return (
                (n.rel = 'stylesheet'),
                (n.type = 'text/css'),
                (n.href = e),
                n.classList.add('SuperCSSInject'),
                n.setAttribute(l, a(e)),
                n
            );
        })(e);
        document.head.append(n);
    }
    function s() {
        const e = new MutationObserver(() => {
            if (document.head.querySelectorAll('link.SuperCSSInject').length > 0) {
                const n = document.head.querySelectorAll("link[rel='stylesheet']");
                'SuperCSSInject' === n[n.length - 1].className
                    || (e.disconnect(),
                    (function () {
                        const e = document.head.querySelectorAll('link.SuperCSSInject');
                        for (const n of e) document.head.appendChild(n);
                        s();
                    })());
            }
        });
        e.observe(document.head, { childList: !0 });
    }
    window.addEventListener('load', function () {
        (e.runtime.onMessage.addListener((s) => {
            const { action: S, urlList: u, webSocketServerURL: C } = s;
            var i;
            'inject' == S
                && ((function (e) {
                    const n = document.querySelectorAll('link.SuperCSSInject'),
                        t = Array.from(n).map((e) => a(e.href)),
                        o = e.map((e) => a(e));
                    for (const e of t) o.includes(e) || c(e);
                    for (let n = 0; n < e.length; n += 1) t.includes(o[n]) || r(e[n]);
                })(u),
                u.length > 0
                    && ((n && n.readyState !== WebSocket.CLOSED)
                        || (t < 3
                            && (console.log(`[SuperCSSInject]: Attempting to connect to Live Reload server on: "${C}"`),
                            (i = C),
                            (n = new WebSocket(i)),
                            n.addEventListener('open', () => {
                                (console.log('[SuperCSSInject]: Connected successfully to Live Reload server:', i),
                                    (o = !0),
                                    e.runtime.sendMessage({ action: 'livereload_connect' }));
                            }),
                            n.addEventListener('error', () => {
                                (t++,
                                    console.log('[SuperCSSInject]: Failed to connect to Live Reload server.'),
                                    console.log('[SuperCSSInject]: Attempts remaining:', 3 - t));
                            }),
                            n.addEventListener('message', () => {
                                (console.log('[SuperCSSInject]: Injected stylesheets changed, refreshing...'),
                                    document.head.querySelectorAll('.SuperCSSInject').forEach((e) => {
                                        (() => {
                                            const n = e.getAttribute(l) || a(e.href);
                                            e.setAttribute(l, n);
                                            const t = e.cloneNode(!1);
                                            (t.href = n, t.setAttribute(l, n), e.replaceWith(t));
                                        })();
                                    }));
                            }),
                            n.addEventListener('close', () => {
                                o
                                    && (console.log('[SuperCSSInject]: Connection to Live Reload server was closed.'),
                                    (o = !1),
                                    (t = 0));
                            })))));
        }),
            e.runtime.sendMessage({ action: 'load' }),
            s());
    });
})();
