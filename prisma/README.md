# Prisma database setup

## 1. Install PostgreSQL (if not already)

- **Windows**: [PostgreSQL installer](https://www.postgresql.org/download/windows/) or `winget install PostgreSQL.PostgreSQL`
- **Mac**: `brew install postgresql@16` then `brew services start postgresql@16`
- **Docker**: `docker run -d --name postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`

## 2. Create the database

```bash
# Using psql (default user postgres)
psql -U postgres -c "CREATE DATABASE leaderboard;"

# Or with password
PGPASSWORD=postgres psql -U postgres -h localhost -c "CREATE DATABASE leaderboard;"
```

## 3. Set DATABASE_URL in .env

In the project root `.env`:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/leaderboard"
```

**Use the password you set when installing PostgreSQL.** If you get `P1000: Authentication failed`, edit `.env` and replace the password in `DATABASE_URL` with your actual postgres user password.

## 4. Apply migrations

From the project root:

```bash
npx prisma migrate deploy
```

(Use `npx prisma migrate dev` during development if you change the schema.)

## 5. (Optional) Seed config

```bash
npm run prisma:seed
```

## 6. Verify connection

```bash
npx prisma db pull   # no-op if already in sync
node view-db.js      # list sites/snapshots/entries
```

After this, the scraper will save results to the database when you run:

```bash
node lbscraper/new-run-scraper.js https://example.com/leaderboard
# or
node lbscraper/new-run-scraper.js --batch
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `P1000: Authentication failed` | Update `.env`: set `DATABASE_URL` with your real PostgreSQL password (the one you chose during install). |
| `P1001: Can't reach database server` | Start PostgreSQL (e.g. Windows: Services → PostgreSQL 16 → Start). |
| `P1003: Database does not exist` | Create it: `CREATE DATABASE leaderboard;` in pgAdmin or `psql -U postgres -c "CREATE DATABASE leaderboard;"`. |
