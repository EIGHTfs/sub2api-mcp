window.__ModuleLoader__.load({
  id: 'dsh-plugin-sub2api',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 内部命名统一前缀 s2m_（防与其他插件撞名 ✓）
    const s2m_react = require('react');

    const S2M_LS = 'dsh-plugin-sub2api:credentials';
    const S2M_API = '/dsh-plugin-sub2api';

    async function s2m_fetchJson(path, opts) {
      const r = await fetch(S2M_API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
      return r.json();
    }

    async function s2m_save(values) {
      try {
        const r = await s2m_fetchJson('/credentials', { method: 'POST', body: JSON.stringify(values) });
        return r && r.ok ? { ok: true, where: 'host', probe: r.probe } : { ok: false, reason: (r && r.error) || '保存失败' };
      } catch (e) {
        try { window.localStorage.setItem(S2M_LS, JSON.stringify(values)); } catch (e2) { /* ignore */ }
        return { ok: false, reason: '宿主路由不可用（' + ((e && e.message) || e) + '），已暂存本地' };
      }
    }

    async function s2m_setProfile(profile) {
      try {
        const r = await s2m_fetchJson('/profile', { method: 'POST', body: JSON.stringify({ profile }) });
        return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || '切换失败' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    }

    async function s2m_logout() {
      try {
        const r = await s2m_fetchJson('/logout', { method: 'POST', body: '{}' });
        return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.error) || '退出失败' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    }

    async function s2m_status() {
      try { return await s2m_fetchJson('/status'); } catch (e) { return { configured: false, error: String((e && e.message) || e) }; }
    }

    function s2m_Field(props) {
      return s2m_react.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 } },
        s2m_react.createElement('span', { style: { opacity: 0.75 } }, props.label),
        props.input
      );
    }

    function s2m_Section() {
      const [form, setForm] = s2m_react.useState(() => {
        try {
          const raw = window.localStorage.getItem(S2M_LS);
          const s = raw ? JSON.parse(raw) : {};
          return { url: s.url || 'http://127.0.0.1:8080', email: s.email || '', password: s.password || '' };
        } catch (e) {
          return { url: 'http://127.0.0.1:8080', email: '', password: '' };
        }
      });
      const [msg, setMsg] = s2m_react.useState('');
      const [busy, setBusy] = s2m_react.useState(false);
      const [status, setStatus] = s2m_react.useState(null);

      s2m_react.useEffect(() => {
        let alive = true;
        s2m_status().then((r) => { if (alive) setStatus(r); });
        return () => { alive = false; };
      }, []);

      const onProfile = async (p) => {
        setBusy(true); setMsg('');
        const r = await s2m_setProfile(p);
        const st = await s2m_status();
        setStatus(st);
        setBusy(false);
        setMsg(r.ok ? ('档位已切换为 ' + p + '（新会话生效）') : ('切换失败：' + (r.reason || '未知原因')));
      };

      const onLogout = async () => {
        setBusy(true);
        setMsg('');
        const r = await s2m_logout();
        const st = await s2m_status();
        setStatus(st);
        setBusy(false);
        setMsg(r.ok ? '已退出登录，可重新填写账号密码' : ('退出失败：' + (r.reason || '未知原因')));
      };

      const onSave = async () => {
        setBusy(true);
        setMsg('');
        const r = await s2m_save(form);
        const st = await s2m_status();
        setStatus(st);
        setBusy(false);
        const p = (r && r.probe) || {};
        setMsg(r.ok
          ? ('已保存' + (p.ok ? '，网关连接正常 ✓' : ('，但网关探测失败：' + (p.error || '未知'))))
          : ('保存失败：' + (r.reason || '未知原因')));
      };

      const input = (key, type, placeholder) => s2m_react.createElement('input', {
        type: type || 'text',
        value: form[key],
        placeholder: placeholder || '',
        onChange: (e) => setForm(Object.assign({}, form, { [key]: e.target.value })),
        style: { padding: 8, borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent' },
      });

      const probeLine = status && status.probe
        ? (status.probe.ok
          ? ('网关探测：✓ healthz ' + status.probe.healthz + ' · ' + (status.probe.accounts != null ? status.probe.accounts + ' 个上游账号' : '') + (status.probe.todayCost != null ? ' · 今日成本 ' + status.probe.todayCost : ''))
          : ('网关探测：✗ ' + (status.probe.error || '失败')))
        : '网关探测：未探测';

      const configured = !!(status && status.configured);
      const statusBox = s2m_react.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, padding: '8px 10px', borderRadius: 6, background: 'rgba(127,127,127,0.12)' } },
        s2m_react.createElement('div', null, '状态：' + (status == null ? '加载中…' : (configured ? '● 已配置' : '○ 未配置'))),
        s2m_react.createElement('div', null, probeLine),
        configured ? s2m_react.createElement('div', { style: { opacity: 0.65 } }, '凭据：' + (status.email || '') + '（密码 ' + (status.passwordMasked || '') + '）') : null,
        configured ? s2m_react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
          s2m_react.createElement('button', { onClick: onLogout, disabled: busy, style: { padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: busy ? 'default' : 'pointer' } },
            busy ? '退出中…' : '退出登录'),
          s2m_react.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, msg)
        ) : null
      );
      const hints = s2m_react.createElement('div', { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.6 } },
        s2m_react.createElement('div', null, '· MCP 服务器：sub2api-mcp（默认只读档 readonly；工具数随档位 9 / 18 / 19）'),
        s2m_react.createElement('div', null, '· 工具档位在上方下拉框切换（readonly / readwrite / full），自动写入 mcp.json')
      );
      const header = [
        s2m_react.createElement('h3', { key: 't', style: { margin: 0 } }, 'Sub2API 网关'),
        s2m_react.createElement('p', { key: 'd', style: { margin: 0, opacity: 0.7, fontSize: 12 } },
          configured ? '已连接网关。退出登录后可重新填写账号密码。'
                     : '用管理员账号连接 Sub2API。保存后 MCP 工具即可通过网关管理用户 / 余额 / 上游账号 / 分组 / API Key。'),
        statusBox,
      ];

      // ── 已配置：隐藏表单，只给「退出登录」✓
      if (configured) {
        return s2m_react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 } },
          ...header,
          s2m_react.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 } },
            s2m_react.createElement('span', { style: { opacity: 0.75 } }, 'MCP 工具档位'),
            s2m_react.createElement('select', {
              value: (status && status.toolProfile) || 'readonly',
              disabled: busy,
              onChange: (e) => onProfile(e.target.value),
              style: { padding: 8, borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent' },
            },
              s2m_react.createElement('option', { value: 'readonly' }, 'readonly —— 只读（9 个工具，推荐）'),
              s2m_react.createElement('option', { value: 'readwrite' }, 'readwrite —— 读写（18 个工具）'),
              s2m_react.createElement('option', { value: 'full' }, 'full —— 全权（19 个工具，含删除）')
            ),
            s2m_react.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, '切换后自动更新 mcp.json，新会话生效')
          ),
          hints
        );
      }

      // ── 未配置：显示表单 ✓
      return s2m_react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 } },
        ...header,
        s2m_react.createElement(s2m_Field, { label: '网关地址', input: input('url', 'text', 'http://127.0.0.1:8080') }),
        s2m_react.createElement(s2m_Field, { label: '管理员邮箱', input: input('email', 'text', 'admin@example.com') }),
        s2m_react.createElement(s2m_Field, { label: '密码', input: input('password', 'password', '') }),
        s2m_react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          s2m_react.createElement('button', { onClick: onSave, disabled: busy, style: { padding: '8px 16px', borderRadius: 6, cursor: busy ? 'default' : 'pointer' } },
            busy ? '保存中…' : '保存'),
          s2m_react.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, msg)
        ),
        hints
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-plugin-sub2api',
        order: 60,
        label: () => 'Sub2API',
      }, () => s2m_react.createElement(s2m_Section, null)));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
