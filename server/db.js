/**
 * Настраивает и экспортирует пул подключений PostgreSQL.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
  PGHOST,
  PGUSER,
  PGPASSWORD,
  PGDATABASE,
  PGPORT,
  PGSSLMODE,
  PGSSL_CA_PATH,
} = process.env;

// Базовые параметры соединения, общие для любых сред.
const connectionConfig = {
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT ? Number(PGPORT) : 5432,
};

// Определяем режим SSL из переменных окружения (по умолчанию verify-full).
const sslMode = (PGSSLMODE || 'verify-full').toLowerCase();

if (sslMode !== 'disable') {
  // Базовый конфиг SSL; при verify-full включаем строгую проверку сертификатов.
  const sslConfig = {
    rejectUnauthorized: sslMode === 'verify-full',
  };

  // Абсолютный путь к файлу CA: берём заданный или стандартный root.crt.
  const caPath = PGSSL_CA_PATH
    ? path.resolve(__dirname, '..', PGSSL_CA_PATH)
    : path.resolve(__dirname, '../root.crt');

  if (fs.existsSync(caPath)) {
    // Если сертификат найден, добавляем его в SSL-конфигурацию.
    sslConfig.ca = fs.readFileSync(caPath, 'utf-8');
  }

  // Добавляем SSL-настройки только когда режим SSL не отключён.
  connectionConfig.ssl = sslConfig;
}

// Создаём и переиспользуем пул подключений.
const pool = new Pool(connectionConfig);

module.exports = pool;
