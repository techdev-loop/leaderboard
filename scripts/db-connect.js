#!/usr/bin/env node
/**
 * Test PostgreSQL connection and apply migrations.
 * Usage: node scripts/db-connect.js
 *
 * Before running:
 * 1. Set in .env: DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/leaderboard"
 * 2. Create the database (in pgAdmin or psql): CREATE DATABASE leaderboard;
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execSync } = require('child_process');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Missing DATABASE_URL in .env');
  process.exit(1);
}

// Hide password in log
const safeUrl = url.replace(/:([^@]+)@/, ':****@');
console.log('Connecting:', safeUrl);
console.log('');

try {
  execSync('npx prisma migrate deploy', {
    cwd: require('path').join(__dirname, '..'),
    stdio: 'inherit'
  });
  console.log('');
  console.log('Database connected and migrations applied.');
} catch (e) {
  const out = [e.message, e.stderr, e.stdout].filter(Boolean).join('\n');
  console.error('');
  if (/P1000|Authentication failed/.test(out)) {
    console.error('Authentication failed. Update .env with your PostgreSQL password:');
    console.error('  DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/leaderboard"');
    console.error('');
    console.error('Then create the database (pgAdmin or psql):');
    console.error('  CREATE DATABASE leaderboard;');
  } else if (out.includes('P1001')) {
    console.error('Cannot reach PostgreSQL. Is the service running? (e.g. Services -> PostgreSQL 16 -> Start)');
  } else if (out.includes('P1003')) {
    console.error('Database "leaderboard" does not exist. Create it in pgAdmin or psql: CREATE DATABASE leaderboard;');
  } else {
    console.error('Fix .env DATABASE_URL (user/password), ensure DB exists, then run: npx prisma migrate deploy');
  }
  process.exit(1);
}
