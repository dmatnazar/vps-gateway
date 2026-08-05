VPS Gateway — Dynamic API Engine (Backend)
This project is a multi-tenant API gateway built with Fastify + TypeScript. It receives dynamic configurations from the Electron admin application and executes MSSQL queries.

1. Prerequisites
Node.js (v18 or v20) — Download from https://nodejs.org

(Optional) MSSQL Server — For testing with a live database

To verify that both are installed, run the following in your terminal (cmd/PowerShell/Terminal):

Bash
node -v
npm -v
2. Installation Steps
Extract the vps-gateway directory to your desired location (e.g., C:\Projects\vps-gateway).

Open a terminal in that folder and run:

Bash
npm install
This installs all required packages (fastify, mssql, zod, etc.). It may take 1–2 minutes.

Copy the .env.example file and rename it to .env:

Bash
# Linux/Mac
cp .env.example .env

# Windows (cmd)
copy .env.example .env
Open the .env file and update these three required values:

Фрагмент кода
JWT_SECRET=your-long-secret-key
ADMIN_SYNC_SECRET=your-second-long-secret-key
CONN_STRING_SECRET=64-character-hex-key
To generate a 64-character random hex key for CONN_STRING_SECRET, run:

Bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Copy the generated output string and paste it into .env.

3. Running the Server
Bash
npm run dev
You should see output similar to this in the terminal:

Plaintext
🚀 Gateway running at http://0.0.0.0:4000
   Health check:   http://localhost:4000/health
   Sync endpoint:  POST http://localhost:4000/api/admin/sync-schema
Verify in your browser or terminal:

Bash
curl http://localhost:4000/health
Expected response: {"status":"ok","time":"..."} — indicating the server is running properly.

4. Connecting with the Electron Admin App
In the Electron app Settings page, set the "VPS Gateway URL" to http://localhost:4000 (if both are running on the same machine).

The admin key in the Electron app (the ADMIN_SECRET variable under the Endpoints page) must match the ADMIN_SYNC_SECRET value in your .env file — otherwise signature verification will fail.

5. Production Build
Bash
npm run build   # Compiles into the dist/ directory
npm start       # Executes the compiled production code
For production deployment, running a process manager like PM2 is recommended:

Bash
npm i -g pm2
pm2 start dist/server.js --name vps-gateway
6. Useful Verification Commands
curl http://localhost:4000/health — Checks server health status.

curl http://localhost:4000/api/admin/routes — Lists all currently loaded dynamic routes.

Click "Sync to VPS" inside the Electron app — new endpoints will be loaded live without needing a server restart (hot-reload).

Troubleshooting
ECONNREFUSED error — The server is not running; execute npm run dev again.

Invalid admin signature — The secret key in the Electron app does not match ADMIN_SYNC_SECRET in .env.

MSSQL connection error — Expected if a live MSSQL instance is not attached yet; provide a valid connection string when adding a tenant.
