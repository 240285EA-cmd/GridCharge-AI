# GridCharge AI — Map + GitHub Pages setup

## Local frontend
```powershell
cd frontend
npm install
npm run dev
```

## GitHub Pages
Repository: `https://github.com/240285EA-cmd/GridCharge-AI`

The Vite base is already set to `/GridCharge-AI/`.

Run:
```powershell
cd frontend
npm install
npm run deploy
```

This builds the frontend and publishes `dist/` to the `gh-pages` branch.

In GitHub, open **Settings → Pages** and set the source to the **gh-pages** branch (root folder).

## Backend CORS
`backend/main.py` reads `ALLOWED_ORIGINS` from the environment. The default allows local Vite and `https://240285EA-cmd.github.io`.

For another deployment origin, set `ALLOWED_ORIGINS` as a comma-separated list.
