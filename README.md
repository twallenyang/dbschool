# 校園設備借用管理系統

本專案是資料庫課程期末專案，主題為「校園設備借用管理系統」。系統使用單一 HTML 前端、Node.js + Express 後端，以及 MS SQL Server 資料庫。

## 技術架構

```text
public/index.html
        ↓ fetch()
Node.js + Express API
        ↓ mssql / msnodesqlv8
MS SQL Server
```

使用技術：

- Frontend：原生 HTML、CSS、JavaScript
- Backend：Node.js、Express
- Database：Microsoft SQL Server
- SQL 連線：`mssql`、`msnodesqlv8`
- 設定檔：`.env`

## 專案結構

```text
Schoolproject/
├─ server.js
├─ db.js
├─ package.json
├─ .env.example
├─ README.md
└─ public/
   ├─ index.html
   └─ logo.png
```

`logo.png` 是校徽圖片，可自行放入 `public` 資料夾。

## 環境設定

請建立 `.env`，範例：

```env
PORT=3030
DB_SERVER=localhost\SQLEXPRESS
DB_DATABASE=Finalschool
DB_TRUSTED_CONNECTION=true
DB_ODBC_DRIVER=ODBC Driver 17 for SQL Server
DB_ENCRYPT=false
DB_TRUST_SERVER_CERTIFICATE=true
```

本專案目前使用 Windows 驗證連線 SQL Server，所以不需要 SQL 帳號密碼。

## 安裝與啟動

安裝套件：

```bash
npm install
```

啟動伺服器：

```bash
npm start
```

瀏覽器開啟：

```text
http://localhost:3030
```

若 `.env` 的 `PORT` 改成其他值，網址也要跟著改。

## 登入方式

登入帳號使用 `USER_ACCOUNT.Email`。

密碼直接比對 `USER_ACCOUNT.Password` 欄位。

範例：

```sql
ALTER TABLE USER_ACCOUNT
ADD Password NVARCHAR(255) NULL;

UPDATE USER_ACCOUNT
SET Password = 'admin123'
WHERE Role = 'Admin';
```

登入後系統會依照 `Role` 判斷權限：

- `Admin`：可以審核借用申請
- `Student` / `Teacher`：可以查看設備與新增借用申請

## 主要功能

- 登入 / 登出
- 儀表板統計
- 設備清單查詢
- 新增借用申請
- 管理員審核申請
- 借用紀錄與歸還明細查詢
- 查詢報表

新增借用申請時，系統會檢查：

- 設備必須是 `Available`
- 歸還日期不可早於借用日期
- 同一設備不可在重疊日期內重複申請

## 主要 API

```text
GET  /api/health
POST /api/login
GET  /api/equipment
GET  /api/users
GET  /api/borrow-requests
POST /api/borrow-requests
PUT  /api/borrow-requests/:id/approve
PUT  /api/borrow-requests/:id/reject
GET  /api/borrow-records
GET  /api/return-records
GET  /api/reports/join
GET  /api/reports/aggregate
GET  /api/reports/subquery
```

## 三個查詢報表

三個主要報表 SQL 寫在 `server.js`。

### JOIN 查詢

API：

```text
GET /api/reports/join
```

用途：顯示借用申請、申請人、設備、設備類別與申請狀態。

前端按鈕名稱：

```text
借用明細報表
```

### Aggregate 查詢

API：

```text
GET /api/reports/aggregate
```

用途：統計每個設備類別被借用的次數。

前端按鈕名稱：

```text
類別借用統計
```

### Subquery 查詢

API：

```text
GET /api/reports/subquery
```

用途：找出借用次數高於平均值的熱門設備。

前端按鈕名稱：

```text
熱門設備分析
```

前端對應函式在 `public/index.html`：

```js
loadJoinReport()
loadAggregateReport()
loadSubqueryReport()
```

## 注意事項

- 前端只有一個頁面：`public/index.html`
- 前端不直接連接 SQL Server，只透過 API
- 後端新增與更新使用參數化查詢
- 本專案是課程展示版，密碼目前使用明文欄位比對；正式系統應改用密碼雜湊
- 若 SQL Server 連線失敗，請確認 SQL Server 服務、SQL Server Browser、TCP/IP 設定與 `.env`

