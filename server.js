const express = require('express');
const cors = require('cors');
const path = require('path');
const { sql, poolPromise } = require('./db');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sendRows(res, result) {
  res.json(result.recordset || []);
}

function validateRequired(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
  return missing;
}

async function ensureAdmin(pool, userId) {
  const result = await pool.request()
    .input('UserID', sql.Int, Number(userId))
    .query(`
      SELECT Role
      FROM USER_ACCOUNT
      WHERE UserID = @UserID;
    `);

  const user = result.recordset[0];
  return user && String(user.Role).trim().toLowerCase() === 'admin';
}

app.get('/api/health', (req, res) => {
  res.json({ message: 'Campus Equipment API is running' });
});

app.get('/api/equipment', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      e.EquipmentID,
      e.EquipmentName,
      e.AssetTag,
      e.Brand,
      e.Model,
      e.PurchaseDate,
      e.Status,
      c.CategoryName
    FROM EQUIPMENT e
    JOIN EQUIPMENT_CATEGORY c
      ON e.CategoryID = c.CategoryID
    ORDER BY e.EquipmentID;
  `);
  sendRows(res, result);
}));

app.get('/api/users', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      ua.UserID,
      ua.FullName,
      ua.Email,
      ua.Role,
      d.DepartmentName
    FROM USER_ACCOUNT ua
    JOIN DEPARTMENT d
      ON ua.DepartmentID = d.DepartmentID
    ORDER BY ua.UserID;
  `);
  sendRows(res, result);
}));

app.post('/api/login', asyncHandler(async (req, res) => {
  const missing = validateRequired(req.body, ['Email', 'Password']);

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  if (new Date(req.body.ExpectedReturnDate) < new Date(req.body.ExpectedBorrowDate)) {
    return res.status(400).json({ error: 'Expected return date cannot be earlier than expected borrow date' });
  }

  const pool = await poolPromise;
  const result = await pool.request()
    .input('Email', sql.NVarChar(255), req.body.Email)
    .input('Password', sql.NVarChar(255), req.body.Password)
    .query(`
      SELECT
        ua.UserID,
        ua.FullName,
        ua.Email,
        ua.Role,
        d.DepartmentName
      FROM USER_ACCOUNT ua
      JOIN DEPARTMENT d
        ON ua.DepartmentID = d.DepartmentID
      WHERE ua.Email = @Email
        AND ua.Password = @Password;
    `);

  const user = result.recordset[0];

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  res.json(user);
}));

app.get('/api/borrow-requests', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      br.RequestID,
      ua.FullName AS ApplicantName,
      STRING_AGG(CONCAT(e.EquipmentName, N'（', e.AssetTag, N'）'), N'、') AS EquipmentInfo,
      br.RequestDate,
      br.ExpectedBorrowDate,
      br.ExpectedReturnDate,
      br.Purpose,
      br.RequestStatus,
      admin.FullName AS ApproverName,
      br.ApprovedAt,
      br.RejectReason
    FROM BORROW_REQUEST br
    JOIN USER_ACCOUNT ua
      ON br.UserID = ua.UserID
    JOIN BORROW_REQUEST_DETAIL brd
      ON br.RequestID = brd.RequestID
    JOIN EQUIPMENT e
      ON brd.EquipmentID = e.EquipmentID
    LEFT JOIN USER_ACCOUNT admin
      ON br.ApprovedBy = admin.UserID
    GROUP BY
      br.RequestID,
      ua.FullName,
      br.RequestDate,
      br.ExpectedBorrowDate,
      br.ExpectedReturnDate,
      br.Purpose,
      br.RequestStatus,
      admin.FullName,
      br.ApprovedAt,
      br.RejectReason
    ORDER BY br.RequestID DESC;
  `);
  sendRows(res, result);
}));

app.post('/api/borrow-requests', asyncHandler(async (req, res) => {
  const missing = validateRequired(req.body, [
    'UserID',
    'EquipmentID',
    'ExpectedBorrowDate',
    'ExpectedReturnDate',
    'Purpose'
  ]);

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const equipmentStatus = await new sql.Request(transaction)
      .input('EquipmentID', sql.Int, Number(req.body.EquipmentID))
      .query(`
        SELECT EquipmentName, Status
        FROM EQUIPMENT
        WHERE EquipmentID = @EquipmentID;
      `);

    const equipment = equipmentStatus.recordset[0];

    if (!equipment) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Equipment not found' });
    }

    if (String(equipment.Status).trim() !== 'Available') {
      await transaction.rollback();
      return res.status(409).json({
        error: 'Equipment is not available',
        details: `${equipment.EquipmentName} 目前狀態不是可借用，無法送出申請。`
      });
    }

    const duplicateCheck = await new sql.Request(transaction)
      .input('EquipmentID', sql.Int, Number(req.body.EquipmentID))
      .input('ExpectedBorrowDate', sql.Date, req.body.ExpectedBorrowDate)
      .input('ExpectedReturnDate', sql.Date, req.body.ExpectedReturnDate)
      .query(`
        SELECT TOP 1
          br.RequestID,
          ua.FullName AS ApplicantName,
          CONVERT(char(10), br.ExpectedBorrowDate, 120) AS ExistingBorrowDate,
          CONVERT(char(10), br.ExpectedReturnDate, 120) AS ExistingReturnDate
        FROM BORROW_REQUEST br
        JOIN BORROW_REQUEST_DETAIL brd
          ON br.RequestID = brd.RequestID
        JOIN USER_ACCOUNT ua
          ON br.UserID = ua.UserID
        WHERE brd.EquipmentID = @EquipmentID
          AND br.RequestStatus IN (N'Pending', N'Approved')
          AND @ExpectedBorrowDate <= br.ExpectedReturnDate
          AND @ExpectedReturnDate >= br.ExpectedBorrowDate
        ORDER BY br.RequestID DESC;
      `);

    if (duplicateCheck.recordset.length > 0) {
      const existing = duplicateCheck.recordset[0];
      await transaction.rollback();
      return res.status(409).json({
        error: 'This equipment already has an overlapping borrow request',
        details: `設備在 ${existing.ExistingBorrowDate} 到 ${existing.ExistingReturnDate} 已由 ${existing.ApplicantName} 申請中或已核准。`
      });
    }

    const requestInsert = await new sql.Request(transaction)
      .input('UserID', sql.Int, Number(req.body.UserID))
      .input('ExpectedBorrowDate', sql.Date, req.body.ExpectedBorrowDate)
      .input('ExpectedReturnDate', sql.Date, req.body.ExpectedReturnDate)
      .input('Purpose', sql.NVarChar(500), req.body.Purpose)
      .query(`
        INSERT INTO BORROW_REQUEST (
          UserID,
          RequestDate,
          ExpectedBorrowDate,
          ExpectedReturnDate,
          Purpose,
          RequestStatus
        )
        OUTPUT INSERTED.RequestID
        VALUES (
          @UserID,
          SYSDATETIME(),
          @ExpectedBorrowDate,
          @ExpectedReturnDate,
          @Purpose,
          N'Pending'
        );
      `);

    const requestId = requestInsert.recordset[0].RequestID;

    await new sql.Request(transaction)
      .input('RequestID', sql.Int, requestId)
      .input('EquipmentID', sql.Int, Number(req.body.EquipmentID))
      .query(`
        INSERT INTO BORROW_REQUEST_DETAIL (
          RequestID,
          EquipmentID
        )
        VALUES (
          @RequestID,
          @EquipmentID
        );
      `);

    await transaction.commit();
    res.status(201).json({ message: 'Borrow request created', RequestID: requestId });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}));

app.put('/api/borrow-requests/:id/approve', asyncHandler(async (req, res) => {
  const missing = validateRequired(req.body, ['ApprovedBy']);

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const pool = await poolPromise;
  const isAdmin = await ensureAdmin(pool, req.body.ApprovedBy);

  if (!isAdmin) {
    return res.status(403).json({ error: 'Only admins can review borrow requests' });
  }

  const result = await pool.request()
    .input('RequestID', sql.Int, Number(req.params.id))
    .input('ApprovedBy', sql.Int, Number(req.body.ApprovedBy))
    .query(`
      UPDATE BORROW_REQUEST
      SET
        RequestStatus = N'Approved',
        ApprovedBy = @ApprovedBy,
        ApprovedAt = SYSDATETIME(),
        RejectReason = NULL
      WHERE RequestID = @RequestID
        AND RequestStatus = N'Pending';
    `);

  if (result.rowsAffected[0] === 0) {
    return res.status(404).json({ error: 'Pending borrow request not found' });
  }

  res.json({ message: 'Borrow request approved' });
}));

app.put('/api/borrow-requests/:id/reject', asyncHandler(async (req, res) => {
  const missing = validateRequired(req.body, ['ApprovedBy', 'RejectReason']);

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const pool = await poolPromise;
  const isAdmin = await ensureAdmin(pool, req.body.ApprovedBy);

  if (!isAdmin) {
    return res.status(403).json({ error: 'Only admins can review borrow requests' });
  }

  const result = await pool.request()
    .input('RequestID', sql.Int, Number(req.params.id))
    .input('ApprovedBy', sql.Int, Number(req.body.ApprovedBy))
    .input('RejectReason', sql.NVarChar(500), req.body.RejectReason)
    .query(`
      UPDATE BORROW_REQUEST
      SET
        RequestStatus = N'Rejected',
        ApprovedBy = @ApprovedBy,
        ApprovedAt = SYSDATETIME(),
        RejectReason = @RejectReason
      WHERE RequestID = @RequestID
        AND RequestStatus = N'Pending';
    `);

  if (result.rowsAffected[0] === 0) {
    return res.status(404).json({ error: 'Pending borrow request not found' });
  }

  res.json({ message: 'Borrow request rejected' });
}));

app.get('/api/borrow-records', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      bor.BorrowRecordID,
      bor.RequestID,
      ua.FullName AS ApplicantName,
      bor.BorrowedAt,
      bor.DueDate,
      handler.FullName AS HandledByName,
      bor.BorrowStatus
    FROM BORROW_RECORD bor
    JOIN BORROW_REQUEST br
      ON bor.RequestID = br.RequestID
    JOIN USER_ACCOUNT ua
      ON br.UserID = ua.UserID
    LEFT JOIN USER_ACCOUNT handler
      ON bor.HandledBy = handler.UserID
    ORDER BY bor.BorrowRecordID DESC;
  `);
  sendRows(res, result);
}));

app.get('/api/return-records', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      rr.ReturnRecordID,
      rr.BorrowRecordID,
      br.RequestID,
      ua.FullName AS ApplicantName,
      rr.ReturnedAt,
      rr.ConditionStatus,
      rr.LateFee,
      handler.FullName AS HandledByName,
      rr.Note
    FROM RETURN_RECORD rr
    JOIN BORROW_RECORD bor
      ON rr.BorrowRecordID = bor.BorrowRecordID
    JOIN BORROW_REQUEST br
      ON bor.RequestID = br.RequestID
    JOIN USER_ACCOUNT ua
      ON br.UserID = ua.UserID
    LEFT JOIN USER_ACCOUNT handler
      ON rr.HandledBy = handler.UserID
    ORDER BY rr.ReturnRecordID DESC;
  `);
  sendRows(res, result);
}));

app.get('/api/reports/join', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      br.RequestID,
      ua.FullName AS ApplicantName,
      ua.Role,
      e.EquipmentName,
      ec.CategoryName,
      br.ExpectedBorrowDate,
      br.ExpectedReturnDate,
      br.RequestStatus
    FROM BORROW_REQUEST br
    JOIN USER_ACCOUNT ua
      ON br.UserID = ua.UserID
    JOIN BORROW_REQUEST_DETAIL brd
      ON br.RequestID = brd.RequestID
    JOIN EQUIPMENT e
      ON brd.EquipmentID = e.EquipmentID
    JOIN EQUIPMENT_CATEGORY ec
      ON e.CategoryID = ec.CategoryID
    ORDER BY br.RequestID;
  `);
  sendRows(res, result);
}));

app.get('/api/reports/aggregate', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      ec.CategoryName,
      COUNT(brd.RequestDetailID) AS BorrowCount
    FROM EQUIPMENT_CATEGORY ec
    LEFT JOIN EQUIPMENT e
      ON ec.CategoryID = e.CategoryID
    LEFT JOIN BORROW_REQUEST_DETAIL brd
      ON e.EquipmentID = brd.EquipmentID
    GROUP BY ec.CategoryName
    ORDER BY BorrowCount DESC;
  `);
  sendRows(res, result);
}));

app.get('/api/reports/subquery', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT
      EquipmentName,
      BorrowCount
    FROM (
      SELECT
        e.EquipmentID,
        e.EquipmentName,
        COUNT(brd.RequestDetailID) AS BorrowCount
      FROM EQUIPMENT e
      LEFT JOIN BORROW_REQUEST_DETAIL brd
        ON e.EquipmentID = brd.EquipmentID
      GROUP BY e.EquipmentID, e.EquipmentName
    ) AS EquipmentBorrowStats
    WHERE BorrowCount > (
      SELECT AVG(BorrowCount * 1.0)
      FROM (
        SELECT
          e.EquipmentID,
          COUNT(brd.RequestDetailID) AS BorrowCount
        FROM EQUIPMENT e
        LEFT JOIN BORROW_REQUEST_DETAIL brd
          ON e.EquipmentID = brd.EquipmentID
        GROUP BY e.EquipmentID
      ) AS AvgStats
    )
    ORDER BY BorrowCount DESC;
  `);
  sendRows(res, result);
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: 'Server error',
    details: err.message
  });
});

app.listen(port, () => {
  console.log(`Campus Equipment API is running at http://localhost:${port}`);
});
