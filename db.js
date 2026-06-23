require('dotenv').config();

const dbPort = process.env.DB_PORT ? Number(process.env.DB_PORT) : 1433;
const trustedConnection = String(process.env.DB_TRUSTED_CONNECTION).toLowerCase() === 'true';
const encrypt = String(process.env.DB_ENCRYPT).toLowerCase() === 'true';
const trustServerCertificate = String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true';
const odbcDriver = process.env.DB_ODBC_DRIVER || 'ODBC Driver 17 for SQL Server';
const sql = trustedConnection ? require('mssql/msnodesqlv8') : require('mssql');

const poolConfig = {
  max: 10,
  min: 0,
  idleTimeoutMillis: 30000
};

const config = trustedConnection
  ? {
      driver: 'msnodesqlv8',
      server: process.env.DB_SERVER || 'localhost',
      database: process.env.DB_DATABASE,
      options: {
        trustedConnection: true,
        encrypt,
        trustServerCertificate
      },
      beforeConnect(conn) {
        conn.conn_str = [
          `Driver={${odbcDriver}}`,
          `Server=${process.env.DB_SERVER || 'localhost'}`,
          `Database=${process.env.DB_DATABASE}`,
          'Trusted_Connection=yes',
          `Encrypt=${encrypt ? 'yes' : 'no'}`,
          `TrustServerCertificate=${trustServerCertificate ? 'yes' : 'no'}`,
          `Trust Server Certificate=${trustServerCertificate ? 'yes' : 'no'}`
        ].join(';');
      },
      pool: poolConfig
    }
  : {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      server: process.env.DB_SERVER || 'localhost',
      database: process.env.DB_DATABASE,
      port: dbPort,
      options: {
        encrypt,
        trustServerCertificate
      },
      pool: poolConfig
    };

if (!process.env.DB_DATABASE) {
  console.warn('DB_DATABASE is not set. Database API routes will fail until .env is configured.');
}

if (!trustedConnection && (!process.env.DB_USER || !process.env.DB_PASSWORD)) {
  console.warn('DB_USER or DB_PASSWORD is not set. Set DB_TRUSTED_CONNECTION=true to use Windows Authentication.');
}

function getErrorMessage(err) {
  if (!err) return 'Unknown database error';
  if (typeof err === 'string') return err;
  if (err.message && err.message !== '[object Object]') return err.message;
  if (err.originalError && err.originalError.message) return err.originalError.message;
  if (err.originalError) return JSON.stringify(err.originalError);
  return JSON.stringify(err);
}

let activePoolPromise;

function getPoolPromise() {
  if (!activePoolPromise) {
    activePoolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log('Connected to MS SQL Server');
        return pool;
      })
      .catch((err) => {
        activePoolPromise = undefined;
        const message = getErrorMessage(err);
        console.error('Database connection failed:', message);
        err.message = message;
        throw err;
      });
  }

  return activePoolPromise;
}

const poolPromise = {
  then(onFulfilled, onRejected) {
    return getPoolPromise().then(onFulfilled, onRejected);
  },
  catch(onRejected) {
    return getPoolPromise().catch(onRejected);
  },
  finally(onFinally) {
    return getPoolPromise().finally(onFinally);
  }
};

module.exports = {
  sql,
  poolPromise
};
