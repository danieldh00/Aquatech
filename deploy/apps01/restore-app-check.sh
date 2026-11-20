#!/usr/bin/env bash
# Gedeeld door restore-test.sh (hersteltest van de PostgreSQL-dump) en restore-test-drive.sh (hersteltest van de Google
# Drive-back-up): start een wegwerp-app op een teruggezette wegwerpdatabase en controleert dat ze werkt. Wordt met
# `source` geladen, dus de variabelen van het aanroepende script gelden hier.
#
# Verwacht: TEST_NETWORK (intern netwerk met de wegwerpdatabase onder de alias `db`), APP_CONTAINER, KEY_FILE, WORK_DIR,
# APP_MEMORY, APP_WAIT_SEC en de variabelen SANITY (JSON-regels, komma-gescheiden), SANITY_FAILED en APP_NOTE.
# Zet: SANITY/SANITY_FAILED/APP_NOTE.
# Zelfde image als de draaiende app, hoogstens APP_MEMORY, alleen het interne netwerk (geen mail, koppelingen of
# synchronisaties naar buiten), alleen-lezen bestandssysteem, kleine wegwerp-datamap (64 MB: een eigen back-up van de app
# past er bij een grote database niet in en mislukt dan netjes in plaats van het geheugen te vullen), CAPTCHA_DISABLED zodat inloggen niet
# naar Google hoeft. De hoofdsleutel gaat alleen-lezen mee: de back-up bevat versleutelde instellingen.
app_check() { # <naam> <ok|fail> <waarde> (zelfde lijst als de sanity-controles)
  if [[ "$2" == ok ]]; then SANITY+="${SANITY:+,}{\"name\":\"$1\",\"value\":1,\"ok\":true}"
  else SANITY+="${SANITY:+,}{\"name\":\"$1\",\"value\":0,\"ok\":false}"; SANITY_FAILED=$((SANITY_FAILED + 1)); fi
}

# Draait de hele app-controle (zie boven).
run_app_check() {
APP_NOTE=""
APP_IMAGE="$(docker inspect -f '{{.Config.Image}}' "${APP_PROD_CONTAINER:-aquatech}" 2>/dev/null || true)"
if [[ -z "$APP_IMAGE" ]]; then
  APP_NOTE="De app-controle is overgeslagen (het image van de draaiende app is niet te vinden). "
elif ! docker run -d --name "$APP_CONTAINER" --memory "$APP_MEMORY" --memory-swap "$APP_MEMORY" --cpus 1 \
    --network "$TEST_NETWORK" --read-only --tmpfs /tmp:rw,size=32m --tmpfs /data:rw,size=64m \
    --security-opt no-new-privileges:true --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
    -v "$KEY_FILE:/run/secrets/master-key:ro" \
    -e PORT=3300 -e DATA_DIR=/data -e RUN_AS_ROOT=1 -e CAPTCHA_DISABLED=1 -e AQUATECH_MASTER_KEY_FILE=/run/secrets/master-key \
    -e "DATABASE_URL=postgres://postgres@db:5432/postgres?sslmode=disable" \
    "$APP_IMAGE" >/dev/null 2>"$WORK_DIR/app.err"; then
  app_check "App-container gestart" fail
  APP_NOTE="De wegwerp-app kon niet starten: $(head -c 150 "$WORK_DIR/app.err" | tr '\n' ' '). "
else
  app_ready=0
  for _ in $(seq 1 $(( APP_WAIT_SEC / 2 ))); do
    docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:3300/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && { app_ready=1; break; }
    [[ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || echo false)" == true ]] || break
    sleep 2
  done
  if (( app_ready == 0 )); then
    app_check "App start op de teruggezette database" fail
    APP_NOTE="De app startte niet op de teruggezette database: $(docker logs --tail 3 "$APP_CONTAINER" 2>&1 | tr -cd '[:print:]\n' | tr '\n' ' ' | head -c 200). "
  else
    app_check "App start op de teruggezette database" ok
    # Het controlescript draait in de wegwerp-app: het zet in de wegwerpdatabase een wegwerpwachtwoord op een actieve
    # beheerder, logt in via de echte inlogroute en haalt een paar kerngegevens op. Uitvoer: ok|naam of fail|naam.
    script_failed=0; script_finished=0
    while IFS='|' read -r verdict name; do
      [[ "$verdict" == ok || "$verdict" == fail ]] || continue
      [[ "$verdict" == fail ]] && script_failed=1
      [[ "$verdict" == ok && "$name" == "Gebruikers ophalen" ]] && script_finished=1
      app_check "$(printf '%s' "$name" | tr -cd 'A-Za-z0-9 ,.()-')" "$verdict"
    done < <(timeout 120 docker exec -i "$APP_CONTAINER" node - 2>/dev/null <<'NODESCRIPT'
const crypto = require('crypto');
const { Client } = require('pg');
const { hashPassword } = require('./src/platform/password-hash');
const base = 'http://127.0.0.1:3300/app';
const say = (ok, name) => console.log(`${ok ? 'ok' : 'fail'}|${name}`);
async function getJson(path, cookie) {
  const response = await fetch(base + path, { headers: cookie ? { cookie } : {} });
  if (!response.ok) return null;
  try { return await response.json(); } catch (error) { return null; }
}
async function main() {
  const status = await getJson('/api/auth/status');
  say(Boolean(status) && status.setupRequired === false, 'App leest de teruggezette gegevens (geen eerste start)');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const found = await client.query("SELECT id, username FROM aquatech.users WHERE role = 'beheerder' AND kind = 'account' AND disabled = 0 AND password_hash IS NOT NULL ORDER BY platform_admin DESC, username LIMIT 1");
  if (!found.rows.length) { say(false, 'Inloggen als beheerder'); await client.end(); return; }
  const password = `Hersteltest-${crypto.randomBytes(9).toString('hex')}!`;
  await client.query('UPDATE aquatech.users SET password_hash = $1, totp_secret = NULL, must_change_password = 0 WHERE id = $2', [await hashPassword(password), found.rows[0].id]);
  await client.end();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: found.rows[0].username, password }) });
  say(login.ok, 'Inloggen als beheerder op de teruggezette gegevens');
  if (!login.ok) return;
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  say(Boolean(await getJson('/api/me', cookie)), 'Eigen account ophalen');
  say(Boolean(await getJson('/api/plans', cookie)), 'Tuinplannen ophalen');
  say(Boolean(await getJson('/api/quotes', cookie)), 'Offertes ophalen');
  say(Boolean(await getJson('/api/admin/users', cookie)), 'Gebruikers ophalen');
}
main().catch((error) => { say(false, 'Controle van de app voltooid'); });
NODESCRIPT
)
    # Geen uitvoer (require mislukt, time-out, docker exec zelf mislukt) mag nooit als geslaagd tellen: de laatste controle
    # van het script moet gelopen hebben, of er moet al een mislukte regel zijn.
    (( script_failed == 1 || script_finished == 1 )) || app_check "Controlescript van de app voltooid" fail
  fi
fi
}
