# WhatsApp Bulk Sender

Local WhatsApp Web sender for opted-in contacts. It supports multiple saved WhatsApp Web accounts, imports an Excel sheet, sends a templated message with optional media, schedules broadcasts, and creates a CSV report after each run.

This uses WhatsApp Web automation, not the WhatsApp Business API. That can be fragile if WhatsApp changes its web UI, and automated bulk messaging may violate WhatsApp's terms if used for unsolicited messages.

## Setup

```powershell
cd C:\Users\adiso\whatsapp-bulk-sender
npm.cmd install
npm.cmd start
```

Open `http://localhost:3000`.

## Accounts

1. Go to **Accounts**.
2. Click **Add Account** and enter a name such as `Sales 1`.
3. Scan the QR code with WhatsApp using **Linked devices**.
4. The linked account is saved locally and can be selected for future broadcasts.

Use **Refresh QR** if the scanner expires or does not appear.
Use **Delete** to remove a saved account and clear its local WhatsApp session from this computer.

## Broadcasts

1. Go to **Broadcasts**.
2. Upload the Excel file and optional media.
3. Choose a linked WhatsApp account.
4. Choose the phone column, write the message, and set delay seconds.
5. Leave schedule time blank to send now, or choose a future time.

Broadcasts on different linked accounts can run at the same time. The app prevents two active broadcasts on the same account to avoid browser/session collisions.

## Excel Format

The first sheet is used. Include a phone column named something like `Phone`, `Mobile`, `WhatsApp`, or `Contact`.

Example columns:

| Name | Phone | City |
| --- | --- | --- |
| Aditi | 9876543210 | Delhi |

Use placeholders in the message with column names:

```text
Hi {Name}, your order is ready in {City}.
```

## Reports

Reports are saved as CSV files in:

```text
C:\Users\adiso\whatsapp-bulk-sender\reports
```

Each row includes the Excel row number, detected number, status, error, and timestamp.
