/* Folgado · serviço de pedidos
   Guarda a prévia e a estampa de cada pedido e mostra uma página privada para o dono.
   Sem dependências: só o Node. Variáveis de ambiente:
     PORT             porta (padrão 3000)
     DATA_DIR         pasta dos arquivos (padrão /data) — monte um volume aqui
     ALLOWED_ORIGIN   site autorizado a enviar (padrão https://folgado.bernassx.cloud). "*" libera tudo (só para teste)
     PUBLIC_URL       endereço público deste serviço (ex.: https://pedidos.bernassx.cloud)
     RETENTION_DAYS   dias até apagar pedidos antigos (padrão 60)
*/
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || "/data";
const ORIGIN = process.env.ALLOWED_ORIGIN || "https://folgado.bernassx.cloud";
const PUBLIC = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const KEEP_DAYS = +process.env.RETENTION_DAYS || 60;
const MAX_BODY = 30 * 1024 * 1024, MAX_FILE = 12 * 1024 * 1024, MAX_FILES = 6;
const RATE_MAX = 20, RATE_WIN = 60 * 60 * 1000;
const ID_RE = /^FLG-\d{4}-[A-Z2-9]{4}$/, TOKEN_RE = /^[a-f0-9]{24}$/, FILE_RE = /^[a-z0-9._-]{1,60}$/;
fs.mkdirSync(DATA, { recursive: true });

const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < RATE_WIN);
  a.push(now); hits.set(ip, a); return a.length > RATE_MAX;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < RATE_WIN)) hits.delete(k); }, RATE_WIN).unref();

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

function cors(req, res) {
  const o = req.headers.origin;
  if (ORIGIN === "*") res.setHeader("Access-Control-Allow-Origin", "*");
  else if (o && o === ORIGIN) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}
function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0, big = false; const chunks = [];
    req.on("data", c => { n += c.length; if (n > MAX_BODY) { big = true; chunks.length = 0; } else if (!big) chunks.push(c); });
    req.on("end", () => big ? no(Object.assign(new Error("grande"), { code: 413 })) : ok(Buffer.concat(chunks)));
    req.on("error", no);
  });
}

async function criar(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { erro: "muitos pedidos, tente mais tarde" });
  let j;
  try { j = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { erro: e.code === 413 ? "arquivos grandes demais" : "json inválido" }); }
  if (!j || !ID_RE.test(j.id || "")) return send(res, 400, { erro: "número de pedido inválido" });
  if (!Array.isArray(j.files) || !j.files.length || j.files.length > MAX_FILES) return send(res, 400, { erro: "arquivos inválidos" });
  const dir = path.join(DATA, j.id);
  if (fs.existsSync(dir)) return send(res, 409, { erro: "pedido já existe" });
  const out = [];
  for (const f of j.files) {
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(f && f.dataUrl || "");
    if (!m || !FILE_RE.test(f.nome || "")) return send(res, 400, { erro: "arquivo inválido" });
    const buf = Buffer.from(m[2], "base64");
    const png = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50, jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
    if (buf.length > MAX_FILE || !(m[1] === "image/png" ? png : jpg)) return send(res, 400, { erro: "arquivo inválido" });
    out.push({ nome: f.nome.replace(/\.(jpe?g|png)$/i, "") + (png ? ".png" : ".jpg"), buf, tipo: png ? "image/png" : "image/jpeg" });
  }
  const token = crypto.randomBytes(12).toString("hex");
  const rows = (Array.isArray(j.rows) ? j.rows : []).slice(0, 30).map(r => [clip(r[0], 60), clip(r[1], 400)]);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of out) fs.writeFileSync(path.join(dir, f.nome), f.buf);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: j.id, token, criado: new Date().toISOString(), rows, files: out.map(f => ({ nome: f.nome, tipo: f.tipo })) }));
  const base = PUBLIC || (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;
  send(res, 200, { ok: true, url: `${base}/p/${j.id}/${token}` });
}

function meta(id, token) {
  if (!ID_RE.test(id) || !TOKEN_RE.test(token)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DATA, id, "meta.json"), "utf8"));
    const a = Buffer.from(m.token), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? m : null;
  } catch (e) { return null; }
}

function pagina(m) {
  const base = `/f/${m.id}/${m.token}/`;
  const rows = m.rows.map(r => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join("");
  const imgs = m.files.map(f => {
    const prev = /^previa/.test(f.nome), nm = esc(f.nome);
    return `<figure><div class="im${prev ? "" : " xadrez"}"><img src="${base}${nm}" alt="${nm}"></div><figcaption><span>${prev ? "Prévia" : "Estampa em tamanho real"} · ${nm}</span><a class="bt" href="${base}${nm}" download="${m.id}-${nm}">Baixar</a></figcaption></figure>`;
  }).join("");
  const quando = new Date(m.criado).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="only light"><title>Pedido ${esc(m.id)} · Folgado</title>
<style>:root{color-scheme:only light}*{box-sizing:border-box}body{margin:0;background:#FFFBF2;color:#1F1813;font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:22px 16px 48px}
h1{font:600 30px/1.1 Georgia,serif;margin:0 0 4px}.sub{color:#6E6458;margin:0 0 20px}.logo{font:600 22px Georgia,serif;margin-bottom:18px}.logo i{color:#E2742B;font-style:normal}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E7DCC6;border-radius:14px;overflow:hidden;margin-bottom:22px}th,td{text-align:left;padding:10px 14px;vertical-align:top;border-bottom:1px solid #F0E7D3;font-size:15px}th{width:36%;color:#6E6458;font-weight:600}tr:last-child th,tr:last-child td{border-bottom:0}
figure{margin:0 0 22px}.im{border:1px solid #E7DCC6;border-radius:16px;background:#fff;padding:10px}.im img{display:block;width:100%;height:auto;border-radius:10px}.xadrez{background:#cfc9bd repeating-conic-gradient(#e8e3d8 0 25%,#cfc9bd 0 50%) 50%/22px 22px}
figcaption{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;font-size:14px;color:#6E6458}.bt{background:#E2742B;color:#1F1813;font-weight:700;text-decoration:none;border-radius:99px;padding:10px 20px;white-space:nowrap}</style></head><body><main>
<div class="logo">folgado<i>.</i></div><h1>Pedido ${esc(m.id)}</h1><p class="sub">Recebido em ${esc(quando)}. Os dados de entrega e pagamento estão na conversa do WhatsApp.</p>
<table>${rows}</table>${imgs}</main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    cors(req, res);
    const u = new URL(req.url, "http://x"), p = u.pathname;
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true });
    if (req.method === "POST" && p === "/api/pedido") return await criar(req, res);
    let m;
    if (req.method === "GET" && (m = /^\/p\/([^/]+)\/([^/]+)\/?$/.exec(p))) {
      const d = meta(m[1], m[2]); return d ? send(res, 200, pagina(d), "text/html; charset=utf-8", { "Cache-Control": "private, no-store" }) : send(res, 404, "Pedido não encontrado.", "text/plain; charset=utf-8");
    }
    if (req.method === "GET" && (m = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p))) {
      const d = meta(m[1], m[2]), f = d && d.files.find(x => x.nome === m[3]);
      if (!f || !FILE_RE.test(m[3])) return send(res, 404, "Arquivo não encontrado.", "text/plain; charset=utf-8");
      return send(res, 200, fs.readFileSync(path.join(DATA, m[1], f.nome)), f.tipo, { "Cache-Control": "private, max-age=3600" });
    }
    if (req.method === "GET" && p === "/") return send(res, 200, "Folgado · pedidos", "text/plain; charset=utf-8");
    send(res, 404, "Não encontrado.", "text/plain; charset=utf-8");
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { erro: "erro interno" }); }
});

function limpa() {
  const lim = Date.now() - KEEP_DAYS * 864e5;
  for (const d of fs.readdirSync(DATA)) {
    if (!ID_RE.test(d)) continue;
    try { if (fs.statSync(path.join(DATA, d)).mtimeMs < lim) fs.rmSync(path.join(DATA, d), { recursive: true, force: true }); } catch (e) {}
  }
}
limpa(); setInterval(limpa, 6 * 3600 * 1000).unref();
server.listen(PORT, () => console.log("Folgado pedidos na porta " + PORT));
