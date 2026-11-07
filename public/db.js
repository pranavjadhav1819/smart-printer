// db.js: all database access for Smart Print.
// Production: Postgres through DATABASE_URL (for example Supabase). Tables are created automatically on start
// (the same statements are in schema.sql if you prefer to run them yourself).
// Without DATABASE_URL it uses an embedded Postgres (PGlite) in ./data/pgdata, so a local demo needs no setup.
// Times are stored as epoch milliseconds (double precision) so both drivers return plain numbers.
const fs = require('fs');
const path = require('path');

let run = null;
const q = (sql, params = []) => run(sql, params);
const one = async (sql, params) => (await q(sql, params))[0] || null;

const SCHEMA = [
  `create table if not exists users (
     id text primary key,
     email text not null unique,
     password_hash text not null,
     created_at double precision not null
   )`,
  `create table if not exists sessions (
     token_hash text primary key,
     user_id text not null references users(id) on delete cascade,
     expires_at double precision not null
   )`,
  `create table if not exists shops (
     id text primary key,
     owner_id text references users(id),
     name text not null,
     rate_bw double precision not null default 2,
     rate_color double precision not null default 10,
     agent_token text not null,
     created_at double precision not null default 0
   )`,
  `create table if not exists uploads (
     id text primary key,
     shop_id text not null references shops(id),
     pages integer not null,
     data bytea not null,
     created_at double precision not null
   )`,
  `create table if not exists orders (
     id text primary key,
     shop_id text not null references shops(id),
     pages integer not null,
     mode text not null,
     copies integer not null,
     sides text not null,
     printer text,
     amount integer not null,
     status text not null,
     rzp_order_id text,
     rzp_amount integer,
     payment_id text,
     error text,
     created_at double precision not null,
     paid_at double precision,
     print_started_at double precision,
     done_at double precision
   )`,
  'create unique index if not exists shops_agent_token_key on shops (agent_token)',
  'create index if not exists shops_owner on shops (owner_id)',
  'create index if not exists sessions_user on sessions (user_id)',
  'create index if not exists orders_shop_status on orders (shop_id, status)',
  'create index if not exists orders_rzp_order on orders (rzp_order_id)',
];
// Only needed for a database created by the first version of this project (shops had no owner)
const MIGRATIONS = [
  'alter table shops add column if not exists owner_id text references users(id)',
  'alter table shops add column if not exists created_at double precision not null default 0',
];
const RLS_TABLES = ['users', 'sessions', 'shops', 'uploads', 'orders'];

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL, max: 5,
      ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (e) => console.error('[db]', e.message));
    run = async (sql, params) => (await pool.query(sql, params)).rows;
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || path.join(__dirname, 'data', 'pgdata');
    if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
    const pg = new PGlite(dir);
    await pg.waitReady;
    run = async (sql, params) => (await pg.query(sql, params)).rows;
    console.warn('[db] DATABASE_URL is not set: using a local embedded database. Data is lost if this host wipes its disk.');
  }
  for (const statement of SCHEMA) await run(statement);
  for (const statement of MIGRATIONS) await run(statement);
  if (process.env.DATABASE_URL) { // keep Supabase's public API away from these tables; this server connects directly
    for (const t of RLS_TABLES) await run(`alter table ${t} enable row level security`);
  }
}

// ----- accounts and sessions -----
// One statement creates the owner and their shop together, so a failure never leaves half an account
const registerOwner = (o) => q(
  `with u as (insert into users (id, email, password_hash, created_at) values ($1::text, $2::text, $3::text, $7::float8) returning id)
   insert into shops (id, owner_id, name, agent_token, created_at) select $4::text, u.id, $5::text, $6::text, $7::float8 from u`,
  [o.userId, o.email, o.passwordHash, o.shopId, o.shopName, o.agentToken, Date.now()]);
const getUserByEmail = (email) => one('select id, email, password_hash as "passwordHash" from users where email = $1', [email]);
const createSession = (tokenHash, userId, expiresAt) =>
  q('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [tokenHash, userId, expiresAt]);
const sessionUser = (tokenHash) => one(
  'select u.id, u.email from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > $2', [tokenHash, Date.now()]);
const deleteSession = (tokenHash) => q('delete from sessions where token_hash = $1', [tokenHash]);

// ----- shops -----
const shapeShop = (r) => r && { id: r.id, name: r.name, rates: { bw: r.bw, color: r.color } };
const getShop = async (id) => shapeShop(await one('select id, name, rate_bw as bw, rate_color as color from shops where id = $1', [id]));
const shopByToken = async (token) => { const r = await one('select id from shops where agent_token = $1', [token]); return r && r.id; };
const setRates = (id, bw, color) => q('update shops set rate_bw = $2, rate_color = $3 where id = $1', [id, bw, color]);
const shopForOwner = async (ownerId) => {
  const r = await one(
    'select id, name, rate_bw as bw, rate_color as color, agent_token as "agentToken" from shops where owner_id = $1 order by created_at, id limit 1', [ownerId]);
  return r && { ...shapeShop(r), agentToken: r.agentToken };
};
const setAgentToken = (shopId, token) => q('update shops set agent_token = $2 where id = $1', [shopId, token]);

// ----- uploads (the merged PDF is kept here until it is printed, then deleted) -----
const createUpload = (id, shopId, pages, buffer) =>
  q('insert into uploads (id, shop_id, pages, data, created_at) values ($1, $2, $3, $4, $5)', [id, shopId, pages, buffer, Date.now()]);
const getUpload = (id) => one('select id, shop_id as "shopId", pages, created_at as "createdAt" from uploads where id = $1', [id]);
const getUploadData = async (id) => { const r = await one('select data from uploads where id = $1', [id]); return r && Buffer.from(r.data); };

// ----- orders -----
const ORDER = `id, shop_id as "shopId", pages, mode, copies, sides, printer, amount, status,
  rzp_order_id as "rzpOrderId", rzp_amount as "rzpAmount", payment_id as "paymentId", error,
  created_at as "createdAt", paid_at as "paidAt"`;
const getOrder = (id) => one(`select ${ORDER} from orders where id = $1`, [id]);
const findOrderByRzpId = (rzpOrderId) => one(`select ${ORDER} from orders where rzp_order_id = $1`, [rzpOrderId]);
const listOrders = (shopId, limit) => q(`select ${ORDER} from orders where shop_id = $1 order by created_at desc limit $2`, [shopId, limit]);

// Create the order, or change its options while it is still unpaid (a paid order is never changed)
async function upsertOrder(o) {
  const row = await one(
    `insert into orders (id, shop_id, pages, mode, copies, sides, printer, amount, status, rzp_order_id, rzp_amount, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'awaiting_payment', $9, $10, $11)
     on conflict (id) do update set pages = excluded.pages, mode = excluded.mode, copies = excluded.copies,
       sides = excluded.sides, printer = excluded.printer, amount = excluded.amount,
       rzp_order_id = excluded.rzp_order_id, rzp_amount = excluded.rzp_amount
     where orders.status = 'awaiting_payment'
     returning ${ORDER}`,
    [o.id, o.shopId, o.pages, o.mode, o.copies, o.sides, o.printer, o.amount, o.rzpOrderId || null, o.rzpAmount || null, o.createdAt || Date.now()]);
  return row || getOrder(o.id);
}

// Payment confirmed. One atomic statement: a duplicate confirmation finds the status already changed and does nothing.
const markPaid = (id, paymentId) => one(
  `update orders set status = case when exists (select 1 from uploads where id = $1) then 'queued' else 'paid_needs_refund' end,
     payment_id = $2, paid_at = $3
   where id = $1 and status in ('awaiting_payment', 'expired') returning ${ORDER}`,
  [id, paymentId || null, Date.now()]);

// The agent asks for the next paid job; the job is claimed in the same statement so two agents can never take it twice
const claimNextJob = (shopId) => one(
  `update orders set status = 'printing', print_started_at = $2
   where id = (select id from orders where shop_id = $1 and status = 'queued' order by paid_at limit 1 for update skip locked)
   returning id, printer, copies, sides, mode`,
  [shopId, Date.now()]);

async function finishOrder(id, ok, error) {
  if (ok) {
    await q(`update orders set status = 'done', done_at = $2 where id = $1 and status in ('printing', 'print_failed')`, [id, Date.now()]);
    await q('delete from uploads where id = $1', [id]); // privacy: the file is removed as soon as it is printed
  } else {
    await q(`update orders set status = 'print_failed', error = $2 where id = $1 and status = 'printing'`,
      [id, String(error || 'Unknown printer error').slice(0, 200)]);
  }
}

const reprint = async (id, shopId) => !!(await one(
  `update orders set status = 'queued', paid_at = $2
   where id = $1 and shop_id = $3 and status = 'print_failed' and exists (select 1 from uploads where id = $1) returning id`,
  [id, Date.now(), shopId]));

const earnedToday = async (shopId, since) => (await one(
  `select coalesce(sum(amount), 0)::float8 as total from orders where shop_id = $1 and status = 'done' and paid_at >= $2`,
  [shopId, since])).total;

// Housekeeping: expire unpaid orders, release stuck print jobs, delete old files
async function sweep({ unpaidMs, ttlMs, stuckMs }) {
  const now = Date.now();
  await q(`update orders set status = 'expired' where status = 'awaiting_payment' and created_at < $1`, [now - unpaidMs]);
  await q(`update orders set status = 'print_failed', error = 'Printer did not respond' where status = 'printing' and print_started_at < $1`, [now - stuckMs]);
  await q('delete from sessions where expires_at < $1', [now]);
  await q(`delete from uploads where created_at < $1 or id in (select id from orders where status = 'done')`, [now - ttlMs]);
}

module.exports = {
  SCHEMA, MIGRATIONS, RLS_TABLES, init,
  registerOwner, getUserByEmail, createSession, sessionUser, deleteSession,
  getShop, shopByToken, shopForOwner, setRates, setAgentToken,
  createUpload, getUpload, getUploadData,
  getOrder, findOrderByRzpId, listOrders, upsertOrder, markPaid, claimNextJob, finishOrder, reprint, earnedToday, sweep,
};
