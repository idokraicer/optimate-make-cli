# App Catalog API Integration

## Goal

Add Make.com app/module catalog access to `MakeApiClient` so AI agents can discover available apps and modules when building scenarios autonomously.

## Endpoints

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/v2/imt/apps-meta` | Token | Full catalog (~2,700 apps, 537KB, <1s) |
| `GET /api/v2/imt/apps/{name}/{version}/modules-with-credentials` | Token | Modules for one app |

No server-side filtering available — client-side search only.

## Design: Thin wrapper + search helper

### New types (`src/make-api/types.ts`)

```ts
interface MakeApp {
  name: string;        // "google-sheets"
  label: string;       // "Google Sheets"
  version: number;     // 2
  theme: string;       // "#0f9d58"
  keywords: string;    // "spreadsheet,sheets"
  categories: string[];
  isPrivate: boolean;
  premiumTier: number;
}

interface AppModule {
  id: string;          // "addRow"
  name: string;        // "addRow"
  label: string;       // "Add a Row"
  type: string;        // "account:google"
  hook: boolean;
}
```

### New methods on `MakeApiClient`

```ts
fetchApps(opts?: { skipSdkApps?: boolean }): Promise<MakeApp[]>
fetchAppModules(appName: string, version: number): Promise<AppModule[]>
searchApps(query: string, apps?: MakeApp[]): Promise<MakeApp[]>
```

`searchApps` fetches apps if not provided, then filters by name/label/keywords match.

### New CLI commands

```
make-fixer apps [query]        # Search/list apps
make-fixer modules <app-name>  # List modules for an app
```
