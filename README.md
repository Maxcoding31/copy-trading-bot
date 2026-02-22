# Solana Copy-Trading Bot

Bot de copy-trading Solana qui reproduit les swaps d'un wallet source via Jupiter.

## RUNBOOK

### A) Lancer la simulation quotidienne

La simulation tourne en continu via PM2. Rien a lancer manuellement.

```bash
# Demarrer / redemarrer
pm2 restart copy-bot

# Verifier que le bot tourne
pm2 status
pm2 logs copy-bot --lines 20

# Dashboard web
http://<IP>:3000
```

Le bot detecte automatiquement les swaps du wallet source toutes les 2 secondes,
execute les trades virtuels et enregistre les resultats en base SQLite.

### B) Lire le rapport journalier

```bash
# Generer le rapport du jour
npm run report:today

# Generer le rapport d'un jour specifique
npm run report:day -- 2026-02-22

# Le fichier est cree dans reports/YYYY-MM-DD.json
```

Le rapport contient :
- Configuration active
- Resume des trades (nombre, volume, PnL)
- Positions ouvertes
- Metriques de slippage (mode LIVE uniquement)
- Win rate et meilleur trade

### C) Passer en LIVE

**Pre-requis :**
1. Verifier que la simulation montre un PnL positif sur plusieurs jours
2. S'assurer que le wallet bot a suffisamment de SOL (via Phantom/CLI)
3. Reduire SLIPPAGE_BPS et MAX_PRICE_IMPACT_BPS a des valeurs raisonnables

**Procedure :**

```bash
# 1. Editer .env sur le serveur
nano .env

# 2. Modifier ces valeurs :
DRY_RUN=false
SLIPPAGE_BPS=200        # reduire de 5000 a 200
MAX_PRICE_IMPACT_BPS=800 # reduire de 10000 a 800

# 3. Redemarrer
pm2 restart copy-bot

# 4. Verifier le log "[LIVE MODE ACTIVE]"
pm2 logs copy-bot --lines 10
```

Le bot affichera un avertissement clair `[LIVE MODE ACTIVE]` au demarrage.
Chaque trade sera compare a la quote Jupiter (compareExecution) avec alertes
si le slippage depasse `COMPARE_ALERT_PCT` (defaut 3%).

### D) Revenir en simulation

```bash
# 1. Editer .env
nano .env

# 2. Modifier :
DRY_RUN=true

# 3. Redemarrer
pm2 restart copy-bot
```

### E) Arret d'urgence

```bash
# Option 1 : Pause (le bot tourne mais rejette tous les trades)
# Via l'interface web : Settings > modifier .env
# Ou directement :
sed -i 's/PAUSE_TRADING=false/PAUSE_TRADING=true/' .env
pm2 restart copy-bot

# Option 2 : Arret complet
pm2 stop copy-bot

# Option 3 : Kill immediat
pm2 kill
```

## Variables d'environnement cles

| Variable | Description | Defaut |
|----------|-------------|--------|
| `DRY_RUN` | `true` = simulation, `false` = reel | `true` |
| `DRY_RUN_ACCURATE` | `true` = simulateTransaction pour fees precis | `false` |
| `COPY_RATIO` | Ratio de copie (0.2 = 20%) | - |
| `MAX_FEE_PCT` | Rejeter si frais > X% du trade | `5` |
| `MIN_SOL_RESERVE` | SOL non depensable (reserve pour frais) | `0.005` |
| `COMPARE_ALERT_PCT` | Alerte Telegram si slippage > X% | `3` |
| `PAUSE_TRADING` | Arret d'urgence sans redemarrage | `false` |

## Scripts npm

| Commande | Description |
|----------|-------------|
| `npm run start` | Demarrer le bot (production) |
| `npm run dev` | Demarrer en mode dev (hot reload) |
| `npm run build` | Compiler TypeScript |
| `npm run report:today` | Generer le rapport du jour |
| `npm run report:day -- YYYY-MM-DD` | Rapport d'un jour specifique |
| `npm run verify` | Script de verification pre-prod |
