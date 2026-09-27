# Create a Google Search Console service account key (JSON)

The server reads your Search Console data with a **Google Cloud service account** — a robot user
that you add to your Search Console properties. It takes about 5 minutes and is free.

## 1. Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/).
2. Project picker (top bar) → **New project** → any name, e.g. `search-console-mcp` → **Create**.

## 2. Enable the Search Console API

1. Open [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com) in the API library.
2. Make sure your new project is selected and click **Enable**.

## 3. Create the service account and a JSON key

1. Go to **IAM & Admin → [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)** → **Create service account**.
2. Name: `search-console-mcp`. Skip the optional role and user access steps → **Done**.
3. Open the service account → **Keys** tab → **Add key → Create new key → JSON** → **Create**.
4. A `.json` file is downloaded. Keep it private — it is a password.

> If your organization blocks key creation (`iam.disableServiceAccountKeyCreation` policy),
> ask your Google Workspace admin to allow it for this project, or create the project in a personal Google account.

## 4. Give the service account access to Search Console

1. Copy the service account email from the key file (`client_email`, looks like
   `search-console-mcp@your-project.iam.gserviceaccount.com`). The status page at
   http://localhost:3333 also shows it after the upload.
2. Open [Search Console](https://search.google.com/search-console) → select the property →
   **Settings → Users and permissions → Add user**.
3. Paste the email, permission **Restricted** (read-only is enough) → **Add**.
4. Repeat for every property (domain or URL-prefix) you want to analyze.

## 5. Load the key into the server

Either upload it on the status page at http://localhost:3333, or copy it to
`credentials/service-account.json` next to `docker-compose.yml` and click **Sync now**.

The first import pulls up to 16 months of data (what Search Console keeps). The most recent days
arrive first, so you can start asking questions within minutes; a big site may need an hour or more
for the full history. After that the server syncs every 6 hours (`SYNC_INTERVAL_HOURS`).

## Troubleshooting

| Status page message | Fix |
|---|---|
| `The service account doesn't have access to any Search Console property yet.` | Step 4 — add the email in Search Console. New users can take a few minutes to apply. |
| `Google rejected the service account key.` | The key was deleted or the service account disabled. Create a new key (step 3). |
| `The Search Console API is not enabled for the key's Google Cloud project.` | Step 2 for the project the key belongs to. |
| `Search Console API quota exceeded` | Nothing to do — the import resumes on the next sync. Lower `SYNC_CONCURRENCY` for huge sites. |
