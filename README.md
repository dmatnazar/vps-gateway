# VPS Gateway — Dinamiki API Motory (Backend)

Bu proýekt Fastify + TypeScript bilen ýazylan, köp-kärhana (multi-tenant) API
gateway'dir. Elektron admin programmasyndan gelen konfigurasiýalary kabul edip,
MSSQL sorag ýerine ýetirýär.

## 1. Talap edilýän programmalar

- **Node.js** (18 ýa-da 20 wersiýa) — https://nodejs.org sahypasyndan ýükläň
- (Islege görä) **MSSQL Server** — hakyky maglumat binýady bilen synamak üçin

Ähliniň gurlandygyny barlamak üçin terminalda (cmd/PowerShell/Terminal):

```bash
node -v
npm -v
```

## 2. Gurnama ädimleri

1. Bu `vps-gateway` papkasyny islendik ýere aç (mysal: `C:\Projects\vps-gateway`).
2. Terminaly şol papkada aç we şu buýrugy ýaz:

```bash
npm install
```

Bu ähli gerekli paketleri (`fastify`, `mssql`, `zod` we ş.m.) ýükleýär. 1-2 minut çeker.

3. `.env.example` faýlyny göçürip, ady `.env` diý:

```bash
# Linux/Mac
cp .env.example .env

# Windows (cmd)
copy .env.example .env
```

4. `.env` faýlyny aç we şu üç bahany hökman üýtget:

```
JWT_SECRET=öz-uzyn-syrly-sözüňiz
ADMIN_SYNC_SECRET=öz-uzyn-syrly-sözüňiz-2
CONN_STRING_SECRET=64-simli-hex-açar
```

`CONN_STRING_SECRET` üçin 64 simli tötänleýin hex-açar döretmek üçin:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Çykan setiri göçürip `.env`-e ýapyşdyryň.

## 3. Işe girizmek

```bash
npm run dev
```

Terminalda şuňa meňzeş ýazgy görünmeli:

```
🚀 Gateway running at http://0.0.0.0:4000
   Health check:   http://localhost:4000/health
   Sync endpoint:  POST http://localhost:4000/api/admin/sync-schema
```

Brauzerde ýa-da terminalda barlaň:

```bash
curl http://localhost:4000/health
```

Jogap: `{"status":"ok","time":"..."}"` — serwer işleýär diýmek.

## 4. Elektron admin programmasy bilen baglanyşyk

Elektron programmasyndaky **Settings** sahypasynda "VPS Gateway URL" ýerine
`http://localhost:4000` ýazyň (ikisi hem şol bir kompýuterde işleýän bolsa).

Elektron programmasyndaky admin syýa (Endpoints sahypasyndaky
`ADMIN_SECRET` üýtgeýjisi) bilen bu ýerdäki `.env`-daky `ADMIN_SYNC_SECRET`
gymmaty **birmeňzeş bolmaly** — ýogsam gol tassyklama şowsuz bolar.

## 5. Önümçilik üçin build

```bash
npm run build   # dist/ papkasyna derleýär
npm start       # derlenen kody işledýär
```

Hakyky serwere göçürmek üçin PM2 ýaly proses dolandyryjy ulanylmagy maslahat berilýär:

```bash
npm i -g pm2
pm2 start dist/server.js --name vps-gateway
```

## 6. Käbir peýdaly barlag buýruklary

- `curl http://localhost:4000/health` — serweriň janlydygyny barlar
- `curl http://localhost:4000/api/admin/routes` — häzirki ýüklenen ähli
  dinamiki marşrutlary (routes) sanawyny görkezer
- Elektron programmasyndan "Sync to VPS" basyň — täze endpoint şu ýere
  gaýtadan başlatmazdan (hot-reload) goşular

## Meseleler bolsa

- `ECONNREFUSED` ýalňyşlygy — serwer işlemeýär, `npm run dev` täzeden işlediň
- `Invalid admin signature` — Elektron programmasyndaky syýa bilen `.env`-daky
  `ADMIN_SYNC_SECRET` gabat gelmeýär
- MSSQL-e birikmek ýalňyşlygy — bu kadaly, sebäbi entek hakyky MSSQL
  serweriňiz baglanan däl; hakyky tenant goşanyňyzda dogry connection string
  ulanyň
"# vps-gateway" 
