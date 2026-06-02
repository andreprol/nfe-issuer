# NFe Issuer

A complete Brazilian NF-e (Nota Fiscal Eletrônica) management system built as a single-page application. Handles invoice issuance, cancellation, XML/PDF downloads, and fiscal reports — integrated with the [Focus NFe API](https://focusnfe.com.br/) and the Brazilian SEFAZ webservices.

## Features

- **NF-e Issuance & Cancellation** — production and sandbox (homologação) environments
- **SEFAZ Integration** — direct SOAP communication with SEFAZ for received NF-e queries (DistDFe)
- **PDF & XML Downloads** — via secure server-side proxy
- **Fiscal Reports** — Sales, Inventory, DRE (P&L), Customers, ABC curve, and NF-e Ledger
- **Role-based Access** — Admin, Operator, and Accountant profiles
- **Multi-device Sync** — data persisted on the server and mirrored to localStorage
- **Digital Certificate** — A1 certificate (.pfx) management for SEFAZ signing
- **Public URL** — served via Cloudflare Tunnel with SSL (no port forwarding needed)

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + JS (no framework, no build step) |
| Backend | Node.js (CommonJS) |
| NF-e API | Focus NFe REST API |
| SEFAZ | SOAP 1.2 + XML-DSig (RSA-SHA256 + C14N) via `node-forge` |
| Data | JSON files (server-side persistence) |
| Tunnel | Cloudflare Tunnel |
| CDN libs | SheetJS (xlsx export), JSZip, node-forge |

## Project Structure

```
emissor-de-notas/
├── index.html            # Full SPA — entire frontend in one file
├── emissor-server.cjs    # Main server — port 3003 (data API + Focus NFe proxy)
├── sefaz-server.cjs      # SEFAZ server — port 3002 (SOAP + XML-DSig)
├── email-server.cjs      # Email server — port 3001 (optional notifications)
├── focus-server.cjs      # Focus NFe helper
├── data/                 # JSON data files (gitignored — contains business data)
├── logs/                 # Runtime logs (gitignored)
└── package.json
```

## Setup

### Prerequisites
- Node.js 18+
- A [Focus NFe](https://focusnfe.com.br/) account (API tokens for homologação and production)
- A valid Brazilian A1 digital certificate (.pfx) for SEFAZ communication
- (Optional) [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for public access

### Installation

```bash
git clone https://github.com/andreprol1980/nfe-issuer.git
cd nfe-issuer
npm install
```

### Configuration

On first run, the system will prompt you to configure through the UI:
- Company details (CNPJ, IE, address)
- Digital certificate (upload .pfx + password)
- Focus NFe API tokens (homologação and production)

Or create `config.json` manually (see `config.json.example` — coming soon).

### Running

Start each server in a separate terminal:

```bash
node emissor-server.cjs   # Main server on port 3003
node sefaz-server.cjs     # SEFAZ server on port 3002
```

Then open `http://localhost:3003` in your browser.

### Running as Windows Services (recommended for production)

Uses [NSSM](https://nssm.cc/) to run as auto-starting Windows services:

```cmd
nssm install EmissorNotas "C:\Program Files\nodejs\node.exe"
nssm set EmissorNotas AppParameters emissor-server.cjs
nssm set EmissorNotas AppDirectory "C:\path\to\emissor-de-notas"
nssm set EmissorNotas Start SERVICE_AUTO_START
nssm start EmissorNotas

nssm install SefazServer "C:\Program Files\nodejs\node.exe"
nssm set SefazServer AppParameters sefaz-server.cjs
nssm set SefazServer AppDirectory "C:\path\to\emissor-de-notas"
nssm set SefazServer Start SERVICE_AUTO_START
nssm start SefazServer
```

## User Roles

| Role | Access |
|---|---|
| `admin` | Full access |
| `operator` | Products, Customers, and Invoice issuance (no Config, Reports, or Users) |
| `accountant` | NF-e Ledger only |

## NF-e Flow

```
User fills invoice form
        ↓
emissor-server.cjs → Focus NFe API → SEFAZ
        ↓
Status polling (authorized / rejected)
        ↓
PDF + XML available for download
```

## SEFAZ Direct Communication (sefaz-server.cjs)

Handles received NF-e queries (DistDFe) directly via SOAP — without going through Focus NFe — using the company's A1 digital certificate for XML signing (RSA-SHA256 + C14N exclusive canonicalization).

Supports both production (`nfe.fazenda.gov.br`) and sandbox (`hom1.nfe.fazenda.gov.br`) environments. State of Rio de Janeiro uses SVRS (Sefaz Virtual do RS) for authorization.

## License

MIT
