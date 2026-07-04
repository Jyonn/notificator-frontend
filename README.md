# Notificator Frontend

An administrator-facing frontend for Notificator, styled like a Windows XP desktop application.

## Features

- Admin login against `POST /api/auth`
- Account list and search
- Create, update, delete, and token renewal for `/api/account/`
- Configurable backend base URL, stored locally in the browser

## Run

```bash
npm install
npm run dev
```

The app defaults to `http://127.0.0.1:8000` unless `VITE_API_BASE_URL` is provided.
