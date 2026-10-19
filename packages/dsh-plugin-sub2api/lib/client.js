window.__ModuleLoader__.load({
  id: 'dsh-plugin-sub2api',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const h = react.createElement;   // 仅用于内部组合；元素调用统一写成 react.createElement（静态解析器可识别 ✓）

    const API = '/dsh-plugin-sub2api';
    const LS = 'dsh-plugin-sub2api:credentials';
    const PROFILES = ['readonly', 'readwrite', 'full'];
    const PROFILE_LABELS = ['只读', '读写', '全权'];
    const PROFILE_HINTS = ['9 个工具 · 推荐', '18 个工具', '19 个工具 · 含删除'];

    // ── 样式（只注入一次 ✓ 参考 dsh-effort-slider 的设计 ✓）──
    const CSS = ''
      + '.s2m_sliderWrap{padding:2px 0 0}'
      + '.s2m_slider{cursor:grab;outline:none;padding:10px 0 4px}'
      + '.s2m_sliderDisabled{cursor:default;opacity:.6}'
      + '.s2m_track{position:relative;height:28px;padding:0 12px}'
      + '.s2m_trackLine{position:absolute;left:12px;right:12px;top:50%;height:10px;border-radius:999px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.18));transform:translateY(-50%)}'
      + '.s2m_fill{position:absolute;left:12px;top:50%;height:10px;border-radius:999px;background-size:100% 100%;transform:translateY(-50%);transition:width .12s ease-out;box-shadow:0 0 12px rgba(120,90,255,.35)}'
      + '.s2m_thumb{position:absolute;top:50%;width:22px;height:22px;border-radius:50%;background:#fff;border:none;box-shadow:0 2px 6px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.06);transform:translate(-50%,-50%);transition:left .12s ease-out}'
      + '.s2m_sliderDragging .s2m_fill,.s2m_sliderDragging .s2m_thumb{transition:none}'
      + '.s2m_sliderDragging{cursor:grabbing}'
      + '.s2m_sliderDragging .s2m_thumb{transform:translate(-50%,-50%) scale(1.12)}'
      + '.s2m_slider:focus-visible .s2m_thumb{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#6b7cff)}'
      + '.s2m_tick{position:absolute;top:50%;width:5px;height:5px;border-radius:50%;transform:translate(-50%,-50%)}'
      + '.s2m_labels{position:relative;height:18px;padding:0 12px}'
      + '.s2m_label{position:absolute;top:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;line-height:18px;transform:translateX(-50%);white-space:nowrap}'
      + '.s2m_label[data-edge="first"]{transform:none}'
      + '.s2m_label[data-edge="last"]{transform:translateX(-100%)}'
      + '.s2m_labelActive{font-weight:600;color:var(--dsw-alias-label-primary,#e6e8eb)}'
      + '.s2m_hint{font-size:11px;opacity:.55;margin-top:2px}';
    function injectCss() {
      try {
        const tagId = 'dsh-plugin-sub2api/client.css';
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-sub2api';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) { /* ignore */ }
    }
    injectCss();

    // ── 宿主 API ──
    async function fetchJson(path, opts) {
      const r = await fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
      return r.json();
    }
    async function saveCreds(values) {
      try {
        const r = await fetchJson('/credentials', { method: 'POST', body: JSON.stringify(values) });
        return r && r.ok ? { ok: true, probe: r.probe } : { ok: false, reason: (r && r.error) || '保存失败' };
      } catch (e) {
        try { window.localStorage.setItem(LS, JSON.stringify(values)); } catch (e2) { /* ignore */ }
        return { ok: false, reason: '宿主路由不可用（' + ((e && e.message) || e) + '）' };
      }
    }
    async function loadStatus() {
      try { return await fetchJson('/status'); } catch (e) { return { configured: false, error: String((e && e.message) || e) }; }
    }
    async function setProfile(p) {
      try {
        const r = await fetchJson('/profile', { method: 'POST', body: JSON.stringify({ profile: p }) });
        return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || '切换失败' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    }
    async function logout() {
      try {
        const r = await fetchJson('/logout', { method: 'POST', body: '{}' });
        return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || '退出失败' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    }

    // ── 滑动条（设计参考 dsh-effort-slider ✓：连续拖动 + 松手吸附 + 刻度 + 渐变）──
    const PAD = 12;
    function s2m_pct(ratio) { return 'calc(' + (PAD) + 'px + (100% - ' + (PAD * 2) + 'px) * ' + ratio + ')'; }
    function s2m_accent(ratio) {
      const stops = [[107, 124, 255], [90, 200, 250], [255, 138, 101]];
      const t = Math.min(0.999, Math.max(0, ratio)) * (stops.length - 1);
      const i = Math.floor(t), f = t - i;
      const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
      const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
      return 'rgb(' + c.join(',') + ')';
    }
    function ProfileSlider(props) {
      const trackRef = react.useRef(null);
      const [dragging, setDragging] = react.useState(false);
      const draggingRef = react.useRef(false);
      const count = PROFILES.length;
      const steps = count - 1;
      const value = Math.min(1, Math.max(0, Number(props.value) || 0));
      const activeIndex = Math.round(value * steps);
      const ratioFromClientX = (clientX) => {
        const el = trackRef.current;
        if (el === null) return 0;
        const rect = el.getBoundingClientRect();
        const inner = rect.width - PAD * 2;
        if (inner <= 0) return 0;
        return Math.min(1, Math.max(0, (clientX - rect.left - PAD) / inner));
      };
      const onPointerDown = (event) => {
        if (props.disabled) return;
        event.preventDefault();
        draggingRef.current = true;
        setDragging(true);
        const el = trackRef.current;
        try { if (el && el.setPointerCapture) el.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        props.onChange(ratioFromClientX(event.clientX));
      };
      const onPointerMove = (event) => { if (draggingRef.current) props.onChange(ratioFromClientX(event.clientX)); };
      const endDrag = (event) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        const el = trackRef.current;
        try { if (el && el.hasPointerCapture && el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        props.onCommit();
      };
      const onKeyDown = (event) => {
        if (props.disabled) return;
        const step = 1 / steps;
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(1, value + step);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, value - step);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 1;
        if (next === null) return;
        event.preventDefault();
        props.onChange(next);
        props.onCommit();
      };
      const ticks = [];
      for (let i = 0; i < count; i++) {
        ticks.push(react.createElement('span', {
          key: 'tick-' + i,
          className: 's2m_tick',
          style: { left: s2m_pct(i / steps), background: i <= activeIndex ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.35)' },
        }));
      }
      const labels = [];
      for (let i = 0; i < count; i++) {
        const pct = i / steps;
        labels.push(react.createElement('span', {
          key: 'label-' + i,
          className: 's2m_label' + (i === activeIndex ? ' s2m_labelActive' : ''),
          style: { left: s2m_pct(pct) },
          'data-edge': i === 0 ? 'first' : (i === count - 1 ? 'last' : undefined),
        }, PROFILE_LABELS[i]));
      }
      return react.createElement('div', { className: 's2m_sliderWrap' },
        react.createElement('div', {
          ref: trackRef,
          className: 's2m_slider' + (dragging ? ' s2m_sliderDragging' : '') + (props.disabled ? ' s2m_sliderDisabled' : ''),
          role: 'slider',
          tabIndex: props.disabled ? -1 : 0,
          'aria-label': 'MCP 工具档位',
          'aria-valuemin': 0,
          'aria-valuemax': count - 1,
          'aria-valuenow': activeIndex,
          'aria-valuetext': PROFILES[activeIndex],
          'aria-disabled': props.disabled || undefined,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onKeyDown: onKeyDown,
          style: { touchAction: 'none' },
        },
          react.createElement('div', { className: 's2m_track' },
            react.createElement('div', { className: 's2m_trackLine' }),
            react.createElement('div', { className: 's2m_fill', style: { width: s2m_pct(value), backgroundImage: 'linear-gradient(90deg, rgb(107,124,255) 0%, ' + s2m_accent(value) + ' 100%)' } }),
            react.createElement('div', { className: 's2m_thumb', style: { left: s2m_pct(value), boxShadow: '0 2px 8px rgba(0,0,0,.35), 0 0 0 2px ' + s2m_accent(value) } }),
            ticks
          )
        ),
        react.createElement('div', { className: 's2m_labels' }, labels),
        react.createElement('div', { className: 's2m_hint' }, PROFILES[activeIndex] + ' —— ' + PROFILE_HINTS[activeIndex])
      );
    }

    function Field(props) {
      return react.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 } },
        react.createElement('span', { style: { opacity: 0.75 } }, props.label),
        props.input
      );
    }

    function Section() {
      const [form, setForm] = react.useState(() => {
        try {
          const raw = window.localStorage.getItem(LS);
          const s = raw ? JSON.parse(raw) : {};
          return { url: s.url || 'http://127.0.0.1:8080', email: s.email || '', password: s.password || '' };
        } catch (e) { return { url: 'http://127.0.0.1:8080', email: '', password: '' }; }
      });
      const [status, setStatus] = react.useState(null);
      const [msg, setMsg] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const [ratio, setRatio] = react.useState(null);

      react.useEffect(() => {
        let alive = true;
        loadStatus().then((r) => {
          if (!alive) return;
          setStatus(r);
          const idx = Math.max(0, PROFILES.indexOf((r && r.toolProfile) || 'readonly'));
          setRatio(idx / (PROFILES.length - 1));
        });
        return () => { alive = false; };
      }, []);

      const refresh = async () => { const st = await loadStatus(); setStatus(st); return st; };

      const onSave = async () => {
        setBusy(true); setMsg('');
        const r = await saveCreds(form);
        const st = await refresh();
        const idx = Math.max(0, PROFILES.indexOf((st && st.toolProfile) || 'readonly'));
        setRatio(idx / (PROFILES.length - 1));
        setBusy(false);
        const p = (r && r.probe) || {};
        setMsg(r.ok ? ('已保存' + (p.ok ? '，网关连接正常 ✓' : ('，但网关探测失败：' + (p.error || '未知')))) : ('保存失败：' + (r.reason || '未知原因')));
      };

      const onCommit = async () => {
        const idx = Math.min(PROFILES.length - 1, Math.max(0, Math.round((ratio == null ? 0 : ratio) * (PROFILES.length - 1))));
        const p = PROFILES[idx];
        setBusy(true); setMsg('');
        const r = await setProfile(p);
        const st = await refresh();
        const stIdx = Math.max(0, PROFILES.indexOf((st && st.toolProfile) || p));
        setRatio(stIdx / (PROFILES.length - 1));
        setBusy(false);
        setMsg(r.ok ? ('档位已切换为 ' + p + '（新会话生效）') : ('切换失败：' + (r.reason || '未知原因')));
      };

      const onLogout = async () => {
        setBusy(true); setMsg('');
        const r = await logout();
        const st = await refresh();
        const idx = Math.max(0, PROFILES.indexOf((st && st.toolProfile) || 'readonly'));
        setRatio(idx / (PROFILES.length - 1));
        setBusy(false);
        setMsg(r.ok ? '已退出登录，可重新填写账号密码' : ('退出失败：' + (r.reason || '未知原因')));
      };

      const configured = !!(status && status.configured);
      const probe = (status && status.probe) || null;
      const probeLine = !probe ? '网关探测：未探测'
        : (probe.ok
          ? ('网关探测：✓ healthz ' + probe.healthz + (probe.accounts != null ? ' · ' + probe.accounts + ' 个上游账号' : '') + (probe.todayCost != null ? ' · 今日成本 ' + probe.todayCost : ''))
          : ('网关探测：✗ ' + (probe.error || '失败')));

      const statusBox = react.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, padding: '8px 10px', borderRadius: 6, background: 'rgba(127,127,127,0.12)' } },
        react.createElement('div', null, '状态：' + (status == null ? '加载中…' : (configured ? '● 已配置' : '○ 未配置'))),
        react.createElement('div', null, probeLine),
        configured ? react.createElement('div', { style: { opacity: 0.65 } }, '凭据：' + (status.email || '') + '（密码 ' + (status.passwordMasked || '') + '）') : null,
        configured ? react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
          react.createElement('button', { onClick: onLogout, disabled: busy, style: { padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: busy ? 'default' : 'pointer' } },
            busy ? '退出中…' : '退出登录'),
          react.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, msg)
        ) : null
      );

      const header = [
        react.createElement('h3', { key: 't', style: { margin: 0 } }, 'Sub2API 网关'),
        react.createElement('p', { key: 'd', style: { margin: 0, opacity: 0.7, fontSize: 12 } },
          configured ? '已连接网关。拖动下方滑块切换 MCP 工具档位；退出登录后可重新填写账号密码。'
                     : '用管理员账号连接 Sub2API。保存后 MCP 工具即可通过网关管理用户 / 余额 / 上游账号 / 分组 / API Key。'),
        statusBox,
      ];

      const sliderBlock = react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        react.createElement('span', { style: { opacity: 0.75, fontSize: 13 } }, 'MCP 工具档位（拖动切换，松手生效）'),
        react.createElement(ProfileSlider, { value: ratio == null ? 0 : ratio, disabled: busy, onChange: setRatio, onCommit: onCommit })
      );

      if (configured) {
        return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 } },
          ...header,
          sliderBlock,
          react.createElement('div', { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.6 } },
            react.createElement('div', null, '· MCP 服务器：sub2api-mcp（readonly 9 / readwrite 18 / full 19 个工具）'),
            react.createElement('div', null, '· 档位切换自动写入 <DSH_HOME>/mcp.json，新会话生效')
          )
        );
      }

      const input = (key, type, placeholder) => react.createElement('input', {
        type: type || 'text',
        value: form[key],
        placeholder: placeholder || '',
        onChange: (e) => setForm(Object.assign({}, form, { [key]: e.target.value })),
        style: { padding: 8, borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent' },
      });

      return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 } },
        ...header,
        react.createElement(Field, { label: '网关地址', input: input('url', 'text', 'http://127.0.0.1:8080') }),
        react.createElement(Field, { label: '管理员邮箱', input: input('email', 'text', 'admin@example.com') }),
        react.createElement(Field, { label: '密码', input: input('password', 'password', '') }),
        react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          react.createElement('button', { onClick: onSave, disabled: busy, style: { padding: '8px 16px', borderRadius: 6, cursor: busy ? 'default' : 'pointer' } },
            busy ? '保存中…' : '保存'),
          react.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, msg)
        ),
        sliderBlock,
        react.createElement('div', { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.6 } },
          react.createElement('div', null, '· MCP 服务器：sub2api-mcp（readonly 9 / readwrite 18 / full 19 个工具）')
        )
      );
    }

    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-plugin-sub2api',
        order: 60,
        label: () => 'Sub2API',
      }, () => react.createElement(Section, null)));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
