/* Trusted QA-only collector. No credentials or response bodies leave the host.
 * Only a short-lived synthetic auth_session is inserted and then expired;
 * all application calls are GET, and no operational row is deleted. */
const crypto = require('node:crypto');
async function probe(deps = {}) {
  const env = deps.env || process.env;
  const report = {version: 1, method: 'synthetic-http', checks: {}, requests: []};
  const check = (name, pass) => { report.checks[name] = pass === true; return pass === true; };
  let client, session;
  try {
    if (!check('qaSafety', env.QA_ENVIRONMENT === 'true' && env.OUTBOUND_ENABLED === 'false' && env.BETTER_AUTH_URL === 'https://qa.goalido.com')) return report;
    const Client = deps.Client || require('/app/node_modules/pg').Client;
    const url = new URL(env.DATABASE_URL);
    if (!check('qaDatabase', url.hostname === 'alido-qa-db.cvceikyc41bm.ca-central-1.rds.amazonaws.com')) return report;
    for (const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl']) url.searchParams.delete(key);
    client = new Client({connectionString: url.toString(), connectionTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 6000, ssl: {rejectUnauthorized: true, ca: (deps.readFile || require('node:fs').readFileSync)(env.DATABASE_CA_FILE, 'utf8')}});
    await client.connect();
    const query = async (sql, values) => (await client.query(sql, values)).rows;
    const [role] = await query('select rolsuper, rolbypassrls from pg_roles where rolname=current_user');
    if (!check('runtimeRole', role?.rolsuper === false && role?.rolbypassrls === false)) return report;
    const [user] = await query('select id,email_verified,two_factor_enabled from auth_user where email=$1', ['vinmesss+qa-other-business@gmail.com']);
    if (!check('syntheticUser', !!user && user.email_verified === true && user.two_factor_enabled === false)) return report;
    await client.query('begin');
    let members;
    try {
      await client.query("select set_config('app.scope','account',true),set_config('app.user_id',$1,true)", [user.id]);
      members = await query('select business_id,role from memberships where user_id=$1', [user.id]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    if (!check('syntheticMembership', members.length === 1 && members[0].business_id === 'qa-synthetic-other-business' && members[0].role === 'owner')) return report;
    // Affirm the two dedicated synthetic fixtures; names are checked but never emitted.
    for (const business of ['qa-synthetic-other-business','qa-synthetic-window-coverings']) {
      await client.query('begin');
      let rows;
      try {
        await client.query("select set_config('app.business_id',$1,true),set_config('app.scope','',true)", [business]);
        rows = await query('select id,name from businesses where id=$1', [business]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      if (!check(business === 'qa-synthetic-other-business' ? 'ownFixture' : 'otherFixture', rows.length === 1 && rows[0].id === business && /QA synthetic/.test(rows[0].name))) return report;
    }
    const token = crypto.randomBytes(24).toString('base64url');
    session = crypto.randomBytes(16).toString('hex');
    await client.query("insert into auth_session(id,user_id,token,expires_at,user_agent) values($1,$2,$3,now()+interval '20 minutes','factory-hosted-acceptance')", [session,user.id,token]);
    const signature = crypto.createHmac('sha256',env.BETTER_AUTH_SECRET).update(token).digest('base64');
    const cookie = '__Secure-better-auth.session_token=' + encodeURIComponent(token+'.'+signature);
    const request = async (label, path, authenticated = true) => {
      const response = await (deps.fetch || fetch)('http://127.0.0.1:3000'+path, {method:'GET',redirect:'manual',signal:AbortSignal.timeout(6000),headers:{...(authenticated?{cookie}:{}),'x-forwarded-proto':'https','x-forwarded-host':'qa.goalido.com'}});
      let body;
      const raw = await response.text();
      if (raw.length > 4*1024*1024) throw Error('oversized');
      try { body = JSON.parse(raw); } catch { body = undefined; }
      report.requests.push({label,status:response.status,jsonObject:!!body&&typeof body==='object'&&!Array.isArray(body)});
      return {status:response.status,body};
    };
    const health = await request('database-health','/api/health',false);
    check('health',health.status === 200 && health.body?.status === 'ok');
    const noSession = await request('unsigned-denial','/api/businesses/qa-synthetic-other-business',false);
    check('unsignedDenied',noSession.status === 401 && noSession.body?.error === 'unauthenticated');
    const own = await request('synthetic-workspace','/api/businesses/qa-synthetic-other-business');
    check('workspace',own.status === 200 && own.body?.business?.id === 'qa-synthetic-other-business' && own.body?.role === 'owner');
    const preferences = await request('synthetic-preferences','/api/account/product-preferences?businessId=qa-synthetic-other-business');
    check('preferences',preferences.status === 200 && !!preferences.body && typeof preferences.body === 'object' && !preferences.body.error);
    const other = await request('other-business-denial','/api/businesses/qa-synthetic-window-coverings');
    check('tenantDenied',other.status === 403 && other.body?.error === 'forbidden');
    for (const [label,path] of [['inbox',''],['follow-ups','/follow-ups'],['leads','/leads'],['bookings','/bookings'],['learning','/learning'],['settings','/settings']]) {
      const response = await (deps.fetch || fetch)('http://127.0.0.1:3000/workspaces/qa-synthetic-other-business'+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(6000),headers:{cookie,'x-forwarded-proto':'https','x-forwarded-host':'qa.goalido.com'}});
      const html = await response.text();
      report.requests.push({label,status:response.status,html:html.includes('<html')});
      check('screen:'+label,response.status === 200 && html.includes('<html') && !html.includes('NEXT_HTTP_ERROR_FALLBACK;500'));
    }
  } catch { report.failure = 'hosted_probe_failed'; }
  finally {
    if (client && session) {
      try {
        const result = await client.query('update auth_session set expires_at=now() where id=$1 returning expires_at<=now() as expired',[session]);
        check('sessionExpired',result.rows.length === 1 && result.rows[0].expired === true);
      } catch { check('sessionExpired',false); }
    }
    if (client) { try { await client.end(); } catch { check('databaseClosed',false); } }
  }
  return report;
}
module.exports = {probe};
if (!module.parent) probe().then(r => process.stdout.write(JSON.stringify(r)+'\n'));
