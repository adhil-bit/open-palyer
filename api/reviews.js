// Reviews for the website, stored as GitHub Discussions in this repo (no database).
//
//   GET  /api/reviews  → approved reviews (Discussions with the "approved" label), with replies
//   POST /api/reviews  → a visitor's review becomes a new Discussion, hidden until approved
//
// Needs the Vercel environment variable GITHUB_TOKEN: a fine-grained token for this repo only,
// with "Discussions: Read and write". Visitors never need a GitHub account.

const OWNER = 'adhil-bit', REPO = 'open-palyer';
const CATEGORY = process.env.REVIEWS_CATEGORY || 'General';
const APPROVED = 'approved';
const MARK = 'op-review';

async function gql(query, variables) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Object.assign(new Error('Reviews are not set up yet (GITHUB_TOKEN missing).'), { status: 503 });
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'open-player-reviews' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw Object.assign(new Error((j.errors && j.errors[0] && j.errors[0].message) || `GitHub error ${r.status}`), { status: 502 });
  return j.data;
}

let ids = null;   // repository + category ids, looked up once per server instance
async function repoIds() {
  if (ids) return ids;
  const d = await gql(`query($o:String!,$n:String!){ repository(owner:$o,name:$n){ id hasDiscussionsEnabled discussionCategories(first:25){ nodes{ id name } } } }`, { o: OWNER, n: REPO });
  const repo = d.repository;
  if (!repo.hasDiscussionsEnabled) throw Object.assign(new Error('Discussions are turned off for the repository.'), { status: 503 });
  const cat = repo.discussionCategories.nodes.find(c => c.name.toLowerCase() === CATEGORY.toLowerCase());
  if (!cat) throw Object.assign(new Error(`No "${CATEGORY}" Discussions category.`), { status: 503 });
  ids = { repo: repo.id, cat: cat.id };
  return ids;
}

const meta = body => {
  const m = /<!--\s*op-review\s+(\{[\s\S]*?\})\s*-->/.exec(body || '');
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
};
const plain = s => String(s || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').trim();

async function list() {
  const d = await gql(`query($o:String!,$n:String!){ repository(owner:$o,name:$n){
      discussions(first:100, orderBy:{field:CREATED_AT, direction:DESC}){ nodes{
        number createdAt body url
        labels(first:10){ nodes{ name } }
        comments(first:10){ nodes{ body createdAt author{ login } } }
      } } } }`, { o: OWNER, n: REPO });
  return d.repository.discussions.nodes
    .filter(x => x.labels.nodes.some(l => l.name === APPROVED))
    .map(x => {
      const m = meta(x.body); if (!m) return null;
      return {
        id: x.number, name: m.name, stars: m.stars || 0, text: m.text, date: x.createdAt, url: x.url,
        replies: x.comments.nodes.map(c => ({
          by: c.author && c.author.login === OWNER ? 'Open Player developer' : (c.author ? c.author.login : 'someone'),
          dev: !!(c.author && c.author.login === OWNER),
          text: plain(c.body).slice(0, 1500), date: c.createdAt,
        })),
      };
    })
    .filter(Boolean);
}

// GitHub Markdown: stop @mentions, #links and HTML from doing anything in a visitor's text
const safe = s => String(s).replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;')).replace(/@/g, '@​').replace(/#(\d)/g, '#​$1');
const hits = new Map();   // simple per-address limit (per server instance)

async function create(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  if (b.website) return { ok: true, pending: true };                   // honeypot: bots fill every field
  if (!(Number(b.t) >= 3000)) throw Object.assign(new Error('Please take a moment to write your review.'), { status: 400 });
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const text = String(b.text || '').trim().slice(0, 1000);
  const stars = Math.max(0, Math.min(5, Math.round(Number(b.stars) || 0)));
  if (!name) throw Object.assign(new Error('Add your name.'), { status: 400 });
  if (text.length < 5) throw Object.assign(new Error('Write a few words about the app.'), { status: 400 });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < 10 * 60e3);
  if (recent.length >= 3) throw Object.assign(new Error('Thanks! You can post again in a few minutes.'), { status: 429 });
  hits.set(ip, [...recent, now]);

  const { repo, cat } = await repoIds();
  const starTxt = stars ? '★'.repeat(stars) + '☆'.repeat(5 - stars) : 'no rating';
  const version = String(b.version || '').replace(/[^\w.\-]/g, '').slice(0, 20);
  const record = JSON.stringify({ name, stars, text, version, at: new Date().toISOString() });
  const body = `**${safe(name)}** · ${starTxt}\n\n${safe(text)}\n\n---\n_Posted from the website. Add the **${APPROVED}** label to show it there._\n\n<!-- ${MARK} ${record.replace(/--/g, '- -')} -->`;
  await gql(`mutation($r:ID!,$c:ID!,$t:String!,$b:String!){ createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){ discussion{ number } } }`,
    { r: repo, c: cat, t: `Review ${starTxt} · ${name}`, b: body });
  return { ok: true, pending: true };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (req.method === 'GET') {
      const reviews = await list();
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).end(JSON.stringify({ reviews }));
    }
    if (req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).end(JSON.stringify(await create(req)));
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    return res.status(e.status || 500).end(JSON.stringify({ error: e.message || 'Something went wrong' }));
  }
};
module.exports._test = { meta, safe };
