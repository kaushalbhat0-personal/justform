# FORMOS-RECON-001 — Full Jotform Capability Reconnaissance

**Date researched:** 2026-10-27 / 2026-10-28 (UTC)
**Author:** Lead Product Reverse-Engineering / Competitive Intelligence (AI-assisted, multi-agent)
**Scope:** Clean-room, public-sources-only reconnaissance. No implementation. No private API access. No copied assets.
**Repo state at time of writing:** empty directory (`D:\Projects\justform` — no files, no framework, no package manager, no DB config) [OBSERVED]
**Evidence legend:** `[CONFIRMED]` = official docs/pages fetched or verified this round. `[OBSERVED]` = public product behavior/docs listing via secondary capture. `[INFERRED]` = reasonable inference, stated as such. `[RECOMMENDATION]` = judgment. `[UNKNOWN]` = not found in reviewed sources.

---

## 1. Executive Summary

Jotform is a broad, all-in-one platform — not just a form builder. Public docs confirm ~15 product surfaces sharing one account/submission model: Form Builder (classic + card/conversational), 20,000+ templates, conditional logic + calculations, Inbox, Tables (spreadsheet DB per form), Workflows (approvals/tasks/payments/sign/email), 30–40+ payment gateways, Sign (e-signature + audit trail), PDF Editor + Smart PDF (PDF→form), Report Builder + Enterprise analytics, Apps/portals, 150–200+ integrations + webhooks, public REST API (key + JS SDK, tiered daily quotas), Mobile Forms (offline + kiosk), and a 2025-era AI layer (form/app generator, AI Agents on 15 channels, AI data assistant) [CONFIRMED — see §3 + sources].

Pricing is the attack surface. Jotform self-serve is **single-user only** through Gold ($0 / $39 / $49 / $129 mo; $34/$39/$99 effective annual), with multi-user, SSO, residency, admin console gated to custom Enterprise; free = 5 forms / 100 subs/mo / 10 payment subs / 100MB upload / Jotform branding [CONFIRMED — direct fetch of jotform.com/pricing 2026-10-27]. Typeform punishes volume (10 → 100 → 1k → 10k responses across $0/$39/$79/$129); Formstack has no free tier ($99 floor); SurveyMonkey paywalls viewing own data; Tally/Fillout/Paperform win on unlimited/generous free + unlimited seats [CONFIRMED — pricing subagent + Tally pricing fetch].

Recurring complaints (multi-source, 2024–2026): response/submission caps, free-tier walls, single-user/Enterprise-gated collaboration (~$9k/yr anecdote for 10 users), bland output/branding confusion, Typeform embed perf + one-question-at-a-time fatigue on long forms, brittle CRM/integration mapping, weak support/billing trust, HIPAA tax (Jotform Gold-only; Tally no BAA), AI upsell without core relief [CONFIRMED — pain-points subagent, multi-source].

**Recommended direction:** JSON-portable form engine you own (RJSF + React Hook Form + Zod hybrid), workspace-first multi-tenancy on Postgres + RLS (Supabase Auth or equivalent), RBAC with 4–5 team roles + resource-level grants, JSON-schema-driven forms with relational tables for everything else, and an MVP scoped as *"teams product that proves architecture"*: auth → workspace → RBAC → schema builder → renderer → publish → submissions inbox → tables views — before workflows/payments/sign/PDF/apps/AI [RECOMMENDATION — see §10–§17].

---

## 2. Product Scope

In scope for the eventual platform (progressive delivery, architecture must pre-accommodate all): Form Builder, Renderer, Templates, Conditional Logic, Calculations, Conversational Forms, Payments, Submissions, Inbox, Tables, Reports, Analytics, Workflows, Approvals, Assignments, Notifications, E-signatures, PDF gen/edit, Apps/portals, Integrations, Webhooks, API, Mobile/PWA, Offline submission, AI-assisted creation/workflows/agents, Team collaboration, RBAC, Workspace management, Enterprise (SSO, residency, audit, DLP) [CONFIRMED as Jotform's surface — §3].

Out of scope for this phase: any implementation, schema migration, dependency install, or architecture decision by assumption.

---

## 3. Jotform Capability Map

### 3.1 Form creation

| Area | Finding |
|---|---|
| Builder | Drag-and-drop with Add Element panel (Basic / Payments / Widgets tabs) [CONFIRMED — help/2-how-to-create-your-first-web-form] |
| Layouts | Classic multi-field page + Card/conversational (one-question-per-page) [CONFIRMED — features/conversational-forms] |
| Mobile builder | Mobile Forms app: create/share/fill offline [CONFIRMED — products/mobile-forms + FAQ] |
| Theming | Theme Store + custom CSS (white-label on Enterprise/paid) [CONFIRMED — theme-store, enterprise/white-label] |
| Templates | 20,000+ form templates; separate galleries for Card/App/Sign/Workflow/AI Agent/Board/PDF/Table/Store [CONFIRMED — form-templates + api docs footer] |
| Cloning/versions | Builder autosave [INFERRED]; named versions / revision history not documented as user-facing [UNKNOWN]. Tally comparison notes 30/90-day history for Tally, Jotform not published per-tier [OBSERVED third-party] |
| Drafts | No explicit drafts doc found [UNKNOWN] |
| Publishing | Link, iframe/JS embed, pop-up, email, QR, social; 8+ sharing options claimed [CONFIRMED — features, features/form-sharing, jotform-vs-tally-forms] |
| Custom URLs/domains | Custom/personalized App URL; custom domains on Enterprise/white-label [CONFIRMED — guide-jotform-apps, enterprise/white-label] |
| Multilingual | Settings → Translate: per-field translations + language switcher [CONFIRMED — features/translate-forms] |
| Conversational | Jotform Cards [CONFIRMED] |
| Accessibility | 50+ locales, RTL, keyboard nav claimed in adjacent engine docs; formal Jotform VPAT [UNKNOWN] |
| Save & continue | Respondent save-progress/resume [CONFIRMED — features/save-and-continue] |
| Prefill | `?fieldUniqueName=value` (+ `name[first/last]`, multi-option commas), Field Prepopulator, form→form, embed query params; Prefill product (from prior submissions/other forms/Excel) [CONFIRMED — help/71-prepopulating + prefill-forms] |
| Hidden fields | Advanced-tab hide; still in reports/integrations/emails/conditions unless Hide Empty Fields; URL-prefillable (IDs, timestamps, calc) [CONFIRMED — help/434-how-to-hide-form-fields] |
| Caps/scheduling | Schedule open/close, submission caps, unique-field limits [CONFIRMED — features + related articles] |
| Assign forms | Assign by email; assignee-filtered submissions [CONFIRMED — help/660-keeping-track-of-your-assignee-submissions, features/assign-forms] |

### 3.2 Field system (from official field list [CONFIRMED — help/46-quick-overview-of-form-fields])

- **Quick:** Header, Full Name, Email (validated), Address, Phone, Date Picker (+time), Appointment (slot-limited booking), Fill in the Blank, Product List, Signature.
- **Basic:** Short/Long Text, Paragraph (rich text + image), Dropdown, Single Choice (radio), Multiple Choice (checkbox), Number, Image, File Upload (drag-drop, plan-capped), Time, Captcha/reCAPTCHA, Spinner, Submit.
- **Survey:** Input Table (single/multi-type columns: radio/checkbox/textbox/dropdown), Star Rating, Scale Rating [CONFIRMED — input-table docs].
- **Structure:** Divider, Section Collapse, Page Break (multi-page).
- **Payments:** Product List + gateway field (see §3.6).
- **Widgets (10,000+ claimed):** e-sign, progress, ratings, Configurable List (multi-field rows: Short Text/Number/Dropdown/Date/Single/Multiple/Paragraph/Long Text/Time), calculators, geolocation/barcode/voice on mobile [CONFIRMED — widgets dir, help/282-configurable-list, mobile-forms].
- Each field: purpose, config options, validation, conditional behavior documented per-field in Help; data representation = per-submission answer map consumed by Tables/Inbox/PDF/API [INFERRED from API + Tables docs].

### 3.3 Logic [CONFIRMED — help/57-smart-forms hub + children]

Show/Hide Field; Update/Calculate Field (math + text manipulation, calc widget, input-table calc); Enable/Require/Mask; Skip To / Hide Page (multipage branching); Change Thank-You (message or conditional redirect); Change Email Recipient (answer-routed notifications); hide-submit-until-choice; password-protect via condition; time-based enable/disable; string manipulation; IF/THEN builder under Settings → Conditions with AND/OR; dynamic dropdown filtering [OBSERVED support pattern]. No native repeat-loop; Configurable List / Input Table used instead [INFERRED]. Dynamic defaults via Update/Calculate + prefill [CONFIRMED].

### 3.4 Submissions — Inbox [CONFIRMED — help/guide-jotform-inbox, features/inbox (+FAQ)]

Unified inbox for submissions + conversations, device-agnostic; search + advanced filter (dates, tags, labels, field values, read/starred); tabs Inbox/Archive/Trash + custom tabs from saved filters; color-coded unlimited tags; comments/@mention, reply/forward, collaborative editing; shareable inbox link; layout customization (alignment, spacing, visible fields, print); status assignment lives in Tables not Inbox [CONFIRMED — help/194-assign-status]; native per-submission single-user assignment NOT supported (support suggests email-forward workaround) [CONFIRMED — answers/5054834]; assignee-filtered views via Assign Form + Inbox tabs [CONFIRMED]; email notification/autoresponder with Hide-Empty-Fields toggle [CONFIRMED]; single + bulk PDF download [CONFIRMED]; attachments downloadable per submission (Tables bulk-download issues reported [OBSERVED]); field-level submission audit history not documented [UNKNOWN]; sign audit separate (§3.7).

Exports: CSV/Excel/PDF per Tables; all-data backup export; Enterprise per-form/multi-form export subject to permission [CONFIRMED — help/44, help/374, G-Cloud listing].

### 3.5 Tables / data [CONFIRMED — help/chapter-139, products/tables/faq, tables guide]

Auto-created spreadsheet DB per form, realtime on submission; views (spreadsheet, card, calendar, uploads, report; multiple tabs/views); custom columns (appended after form fields); filter conditions + saved filters + Lock Column/Filter for collaborators; inline cell edit + concurrent multi-user edit ("Can multiple people edit at same time? Yes"); sharing by email invite or link (Public/Private/org-only; tab-level granularity [UNKNOWN]); roles Read Only / Commenter / Collaborator at table layer; Team Admin / Creator / Data Collaborator / Data Viewer at Teams layer [CONFIRMED — answers/28297221, teams/faq]; CSV/Excel/PDF export.

### 3.6 Workflows [CONFIRMED — help/guide-jotform-workflows + element docs + products/workflows/features]

Visual builder (Add Element canvas + flow lines); trigger = form submission; elements: Approval (one-click, Group Approvals), Send Form, Assign Task, Request Payment (gateway, payer email/amount/reason, Success/Expired, reminders, expiry), Sign Document (Signed/Declined/Canceled branches), Send Payment Form, Send PDF, Send Email, Send Flow Report; outcome-based branching (Approve/Deny, Success/Expired, Signed/Declined/Canceled); reminders/expiry on payment/sign; tracking via Inbox + Tables + Flow Reports + Enterprise Admin Console / Workspace Insights; templates (leave, PO, content approval).

### 3.7 Payments [CONFIRMED — help/323-mastering-payment + help/292-auth-only + use-cases]

PCI DSS L1; card data to gateway, not stored on Jotform; SSL 256-bit; no Jotform commission (gateway fees apply). 30+ named gateways (marketing: 40+): Stripe, PayPal, Square, Authorize.Net, Braintree, Apple/Google Pay, Afterpay/Clearpay, Cash App/Venmo, 2Checkout, BlueSnap, CyberSource, WorldPay UK, Mollie, Moneris, PayFast, PayU (+India), etc. Product List + quantity limits; subscriptions/recurring/installments via gateway + workflow payment requests; donations; tax/discount/coupon/invoice = gateway/product-settings dependent, invoice via PDF + Store Builder [PARTIAL/INFERRED]; statuses pending/approved/refunded filterable in Tables; authorize-only/capture-later on PayPal/Auth.Net/Square/Stripe/Braintree/CyberSource/Eway; checkout + payment-request email customization + reminders.

### 3.8 Signatures — Jotform Sign [CONFIRMED — products/sign/*, help/how-to-use-jotform-sign, workflow sign doc]

Doc gen from submissions → PDF + auto audit trail; Builder (signature/date/initials + form-mapped fields; Smart PDF mapping); Manage Signers (manual or from form fields), access code, custom message; Signing Order toggle (sequential vs parallel, drag reorder); automated reminders, expiry, CC, signer delegation (default on); Sign Inbox (All / Waiting for Me / Others / Completed / Canceled / Declined) + mobile tracking; audit trail (open/view/sign/delegate/complete/download, timestamps, emails, IP/device, MFA/geolocation), downloadable + auto-emailed; ESIGN/UETA, SOC2/HIPAA/GDPR/CCPA/SSL claims. Limitation [OBSERVED]: audit PDF to single email field (forum complaint).

### 3.9 PDF [CONFIRMED — products/pdf-editor(+top-features), smart-pdf-forms, answers threads]

Generation: auto-branded PDFs per response, multiple PDFs per submission, size/orientation/background/logo/fonts/colors drag-drop; editing full; per-condition PDFs = separate documents (no single-PDF conditional sections); templates 600–2,000+; submission→PDF auto-populate + attach to notification/autoresponder + per/bulk download from Tables/Inbox; PDF→form (Smart PDF Forms): upload PDF → mobile-friendly form retaining layout, field mapping, Original PDF + data download, template update without overwriting priors; fillable-PDF version of a form [CONFIRMED support]; arbitrary-external-PDF fill without Smart/PDF Editor NOT supported [CONFIRMED limitation]; filled-Original-PDF via API has no direct endpoint — manual download or external generation [OBSERVED].

### 3.10 Reports / analytics [CONFIRMED — products/report-builder, features/visual-form-reports, enterprise/features/forms/analytics, about timeline]

Report Builder: auto-generate polished reports/presentations, drag-drop tables/charts/images/branding, auto-update on new data, share link/embed/secure PDF; charts bar/pie/grids auto-generated; types excel/csv/grid/table/calendar/rss/visual (per report `list_type`); Enterprise analytics (submissions/fields/thank-you pages), UTM, GA + widgets; Form Analytics (2020) + Encrypted Forms. Scheduled native report scheduler [UNKNOWN — blog describes generic practice; push alternative = workflow Send Flow Report + email alerts]. Native drop-off/conversion depth [PARTIAL/UNKNOWN — Enterprise + GA widgets only].

### 3.11 Apps / portals [CONFIRMED — products/apps(+features), diy-app-builder, drag-and-drop-app-builder, ai/app-generator, help/guide-jotform-apps]

App Builder: bundle forms/links/images/buttons/widgets/integrations into branded web/mobile app; installable iOS/Android/desktop; 800+ templates; 80+ store/app elements (video/maps/social); progress tracking/dynamic widgets; client/staff/event/onboarding/policy portals (positioning); User Management claimed for AI App Builder (respondent-identity depth [UNKNOWN]); logo/icon/colors/fonts/splash, custom App URL (org+app); share link/email/QR any device; ChatGPT/Claude in-chat building; AI Agent chatbot embeddable [CONFIRMED — help/how-to-add-ai-agent-to-apps]. Third-party caution about respondent-identity/status leakage is not Jotform doc [OBSERVED, treat cautiously].

### 3.12 Integrations [CONFIRMED — integrations dir + category pages + webhooks + guide]

150–200+ apps (footer 150+, header 200+). CRM (Salesforce, HubSpot, monday.com, Pipedrive-style via Zapier); storage (Drive, Dropbox, OneDrive, Box, FTP, Egnyte); payments (§3.6); email/marketing (Mailchimp groups/tags, Constant Contact, AWeber, GetResponse); productivity/automation (Sheets, Excel, Slack, Teams, Zapier 3,000+ downstream, IFTTT, Make, Webhooks); calendar (Google Calendar, Calendly conditional); AI (ChatGPT/Claude/Canva apps). Notables: Slack/Teams sync, Sheets/Excel auto-populate, Salesforce lead/contact, Mailchimp tagging, Drive/Dropbox upload sync, WhatsApp Business notifications. Webhooks: POST submission JSON to arbitrary URL; Settings/Integrations setup; PHP examples; API-managed `POST /form/{id}/webhooks` [CONFIRMED — integrations/webhooks, api docs].

### 3.13 API / developer — public docs only [CONFIRMED — direct fetch api.jotform.com/docs 2026-10-27]

Base URLs: `api.jotform.com` (US), `eu-api.jotform.com` (EU), `hipaa-api.jotform.com` (HIPAA), Enterprise custom domain API. Auth: query `?apiKey=`, header `APIKEY:`, JS SDK `JF.login(success,error)` popup + `JF.getAPIKey()` + `JF.initialize({apiKey})` (`js.jotform.com/JotForm.js`); key issuance My Account → API. Standard OAuth2 client-credentials [UNKNOWN — not on reviewed page, do not assume]. REST JSON + JSONP (`?callback=`); resources at minimum user/forms/submissions/reports/folders/files/system/webhooks; report `list_type` excel/csv/grid/table/calendar/rss/visual; writes: create/edit forms, `POST /form/{id}/submissions`, CSV/Excel import scripts. Events: register/list/delete webhooks, realtime POST on submission. **Rate limits (daily): Starter 1,000 / Bronze 10,000 / Silver 50,000 / Gold 100,000 / Enterprise unlimited** + `limit-left` header; EU/HIPAA separate pools. SDKs: Android, C#, Go, iOS, Java, JS, Node (`npm install jotform`), PHP, Python, Ruby, Scala.

### 3.14 Mobile / offline [CONFIRMED — products/mobile-forms(+faq), help/571-kiosk]

iOS/Android: create/share/fill, manage submissions, approve/deny, push on new response, assign forms to team. Offline per-form in Settings; fill/review/edit offline; device-space cap (fullest form auto-disabled first, no data loss); auto-sync on reconnect. Capture: voice, barcode, geolocation, e-sign. Kiosk: single-form lock, auto-refresh, 4-digit PIN (fallback account password), inactivity timeout, Thank-You control, visible Exit, touchless QR (no app), offline-capable. Enterprise white-label native app. AI Agents on mobile (form assistance + human-escalation app).

### 3.15 AI [CONFIRMED DOCUMENTED — help/how-to-use-jotform-ai, ai/form-builder, ai/app-generator, ai/agents, help/ai-agents, about]

AI Form Generator (prompt/file/URL/screenshot/voice → fields + logic + emails + scheduling + thank-you; chatbot iteration; free; mobile-optimized); AI App Builder (describe need → pages/nav/content/workflows; URL-import styling; ChatGPT/Claude in-chat); AI Agents flagship (24/7 support, guided fill, 15 channels, email compose/send, mobile escalation, templates, personas/tones, WP plugin); AI Data Assistant / AI Tables/Workflows/PDF/App enhance (ask questions of submissions, organize/generate table data, draft emails/flows, pre-fill PDFs). ChatGPT/Claude connectors + MCP in nav. **Speculation to exclude:** autonomous approvals, HIPAA-safe LLM retention guarantees, AI accuracy SLA, auto-fix of broken logic (competitor-authored Tally roundup claims Jotform AI can't auto-fix logic — treat as [OBSERVED third-party], verify independently). Jotform disclaims: always review AI output [CONFIRMED].

### 3.16 Enterprise [CONFIRMED — enterprise/*]

Multi-user, Teams, Admin Console, Workspace Insights (submissions/approvals/integrations dashboards), SSO, white-label (+mobile app), local data residency, custom API domain, Professional Services, industry packs (gov/finance/edu/health/nonprofit/field-service), security page. Pricing custom.

---

## 4. Competitor Matrix (comparison/reference)

| Capability | Jotform | Typeform | Tally | Fillout | Formstack | SurveyMonkey | Paperform | Feathery | Formbricks | Google Forms |
|---|---|---|---|---|---|---|---|---|---|---|
| Builder UX | Full drag-drop + Cards | Conversational-first, polished | Simple, fast | Airtable-native, smooth | Powerful but steep learning curve [CONFIRMED G2 theme] | Survey-oriented | Doc-style, design-forward | Dev-friendly, insurance-grade | Survey SDK, self-host | Minimal |
| Free tier | 5 forms/100 subs [CONFIRMED] | 10 resp/mo [CONFIRMED] | Unlimited forms/subs fair-use [CONFIRMED] | 1k resp/mo, unlimited forms/seats [CONFIRMED] | None (14-day trial) [CONFIRMED] | 10 Q / ~25 views [CONFIRMED] | 30 subs/mo [CONFIRMED] | 500 subs/mo, 5 live forms [CONFIRMED] | Community self-host free [CONFIRMED] | Unlimited [CONFIRMED] |
| Paid entry (annual equiv) | $34/mo | $28/mo | $24/mo | $15/mo | $83/mo | ~$39/mo [INFERRED US] | $49/mo | Custom (legacy $49–$190 [INFERRED]) | Legacy $74/mo [INFERRED]; now custom Suite | Via Workspace ~$7/u [INFERRED] |
| Team/multi-user | Enterprise only [CONFIRMED] | 1/3/5 seats by tier [CONFIRMED] | Unlimited members Pro+ [CONFIRMED] | Unlimited seats all tiers [CONFIRMED] | 1/3/custom builders [CONFIRMED] | 3+ on Team [CONFIRMED] | Unlimited [CONFIRMED] | Unlimited, RBAC/SSO paid [CONFIRMED] | Unlimited, SSO/roles paid tier [CONFIRMED] | N/A (Google acct) |
| Workflows/approvals | Native Workflow Builder [CONFIRMED] | Growth add-ons | Basic (email/redirect/close) | Workflows product incl. all tiers | Routing/approvals Suite+ | Basic | Stepper workflows incl. | Strong (verification, KYC) | None (survey focus) | None |
| Payments | 40+ gateways [CONFIRMED] | Stripe (Business+) | Stripe free | No-commission free | Native + Salesforce | Adv+ | 0% fee Stripe/PayPal/Square | Stripe | None | None |
| Signatures | Jotform Sign + audit [CONFIRMED] | Gated/high tiers | E-sign free | Signatures Starter+ | Unlimited eSign Suite | Gated | Papersign (3–100+/mo) | E-sign + doc intel | None | None (Docs eSign separate) |
| PDF | Editor + Smart PDF [CONFIRMED] | Minimal | Minimal | PDF-to-form via AI | Doc-gen 250/mo Suite | Minimal | Docs allotment | PDF-first | None | None |
| Reports/analytics | Report Builder + Ent analytics [CONFIRMED] | Smart Insights, drop-off high tiers | Visit + drop-off (Pro) | Conversion/partial (Business) | Basic | Crosstabs/advanced (Prem) | Report insights (AI) | Strong analytics | Response analytics | Sheets export only |
| Apps/portals | Apps 800+ templates [CONFIRMED] | Minimal | None | Portals (higher tiers) | Portals (Enterprise) | None | Portals/pages | Apps (insurance OS) | None | None |
| API/webhooks | Key + SDKs, tiered quotas [CONFIRMED] | All paid tiers | Free + MCP | REST all tiers | API (developers.formstack) | 200+ integrations | Standard/Business API + S3 BYO | API connectors | API/webhooks/MCP | Workspace API w/ quotas |
| Mobile/offline | Mobile + offline + kiosk [CONFIRMED] | Embed (perf complaints) | Responsive | Mobile (page-transition bug [SINGLE-REPORT]) | Mobile fill | Mobile surveys | Mobile fill | Mobile + meeting notetaker | Mobile surveys | Mobile fill, offline via app |
| AI | Generator + Agents + assistant [CONFIRMED] | AI create + Clarify + lead enrichment | Generate+edit+fix-logic free (competitor claim) | AI form/quiz, PDF-to-form | AI support 24/7 | Analyze + thematic | Form gen + calc + insights | Robin AI, doc intel | Survey AI | Gemini (Workspace) |

Priority key: P0 architectural/core, P1 launch-critical, P2 important, P3 later, P4 experimental. Our planned platform targets parity on P0–P2 first; P3/P4 (portals depth, agents, doc-intel) later [RECOMMENDATION].

---

## 5. Pricing Matrix (researched 2026-10-27/28)

Direct-verified Jotform (fetch 2026-10-27) [CONFIRMED]:

| Plan | Price | Forms | Subs/mo | Views | Upload | Storage | Pay subs | Sign docs | Fields | HIPAA | Brand |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Starter | $0 | 5 | 100 | 10k | 100MB | 500 | 10 | 10 | 100 | No | Jotform |
| Bronze | $39 ($34 annual) | 25 | 1k | 100k | 1GB | 10k | 100 | 100 | 250 | No | Removable |
| Silver | $49 ($39 annual) | 50 | 2.5k | 1M | 10GB | 25k | 250 | 250 | 500 | No | Removable |
| Gold | $129 ($99 annual) | 100 | 10k | 10M | 100GB | 100k | 1k | 1k | 1k | Yes | Removable + custom domain |
| Enterprise | Custom | Unlim | Unlim | Unlim | Unlim | Unlim | Unlim | Unlim | Unlim | Yes | Yes + SSO/residency/CSM |

AI Agent meter (Starter→Gold→Ent): active agents 5/25/50/100/Unlim; convos 100/1k/2.5k/10k/Unlim; sessions 10k/100k/1M/2M/Unlim; voice min 3k/6k/12k/18k/Unlim; KB 10M/20M/50M/100M chars; SMS 250/300/500/750/Unlim; phone add-on US/UK/CA [CONFIRMED].

Others (pricing-subagent, official pages 2026-10-27 — see full breakdown in subagent transcript; headline figures [CONFIRMED] unless noted):

- **Typeform:** $0 (10 resp/mo, 1 user) / Basic $39 ($28 annual, 100/mo, 1 user) / Plus $79 ($56, 1k/mo, 3 users) / Business $129 ($91, 10k/mo, 5 users) / Ent custom. Remove-branding Plus+; custom domain Ent; Stripe Business+; hard response caps; add-ons Contacts +$25 (2.4k acts)/+$75 (12k), Talent HR $169 ($119 annual, 3k).
- **Tally:** $0 unlimited forms+subs fair-use (10MB/file, Sheets/Notion/Airtable/Zapier/Make/webhooks/payments/e-sign free) / Pro $29 ($24 annual) / Business $89 ($74 annual) / custom extensive-use. Pro+: no branding, custom (sub)domain + email domain, unlimited members/workspaces, partials, CSS, OG/link preview, visit + drop-off analytics, 30-day history, GA/Meta. Business+: retention delete, email verify, 90-day history.
- **Fillout:** $0 (unlimited forms/seats, 1k resp/mo, 20MB/file, badge) / Starter $19 ($15, 2k) / Pro $49 ($40, 5k) / Business $89 ($75, unlimited) / Ent custom. Workflows all tiers; respondent emails + signatures Starter+; white-label Pro+; analytics/partial/pixel + prefetch/dedupe/Salesforce higher tiers; custom domain Business; AI form/PDF-to-form.
- **Formstack:** no free (trial only); Forms $99 ($83 annual: 1 builder, 25 forms, 1k subs/form, 2GB) / Suite $299 ($250: 3 builders, 100 forms, 5k subs/form, 10GB, 250 docs/mo, unlimited eSign) / Salesforce + Enterprise custom. Per-form (not pooled) caps. HIPAA add-on.
- **SurveyMonkey:** Basic $0 (1 user, unlimited surveys, 10 Q, ~10–25 viewable) / Standard monthly [INFERRED $99–$149] / Advantage annual [CONFIRMED ₹1,999/mo geo; INFERRED US $39/mo, 1k/mo or 15k/yr] / Team Adv [~$30/u/mo, 50k/yr] / Team Prem [$75–$92/u, 100k/yr] / Ent custom 5+. Overage ~$0.15–₹5/extra. White-label Prem/Ent; BAA/SSO Ent. **Caution: geo-priced fetch (INR); US $ INFERRED.**
- **Paperform:** $0 (unlimited forms/fields/views/users/storage, 30 subs/mo, 100MB, badge) / Pro $59 [INFERRED monthly] / $49 annual (unlimited subs, 10GB) / Business $149/$124 annual (10 workspaces, 100GB, SSO, Business API) / Ent custom. Credits 5k/20k/100k; custom domain Pro +$20 / Business incl / Ent unlim; Papersign 3/25/100/unlim docs/mo; Stripe 0% fee.
- **Feathery:** $0 (unlimited Q/seats, 500 subs/mo, 5 live forms, 10MB) / Growth + Business custom (legacy $49/$99/$190 tiers [INFERRED, no longer listed]). Partials, A/B, CAPTCHA, custom HTML/CSS/SEO/DNS, RBAC/SSO/audit/white-label paid; 100 standard + 50 premium integrations (Stripe, Salesforce, Plaid/Alloy/LexisNexis, SMS OTP, Firebase/Stytch); SOC2/HIPAA/GDPR.
- **Formbricks:** Community self-host (AGPL) free / Experience Suite custom annual (volume × workspaces × term), unlimited seats, SSO/SLA, own-DB, AWS Marketplace. Legacy Cloud Hobby 250/Pro 2k/Scale 5k [INFERRED Aug-2026 captures].
- **Google Forms:** $0 unlimited forms/responses (15GB shared Drive, Sheets export); no paid Forms-only tier — Workspace bundle (Starter ~$7/u, Standard ~$14 [INFERRED]; geo CONFIRMED ₹99/270/1080); uploads → owner quota + respondent login required; no payments/native e-sign (Docs eSign separate); API quotas only.

Overage/billing notes: Jotform warns then upgrade-or-purge (oldest removed if storage exceeded); proration on upgrade, balance carryover on downgrade, cancel → Starter at next bill; nonprofit/edu 50% (30% Ent); 24h 50%-off onboarding promo; 30-day money-back; taxes per locale [CONFIRMED — pricing FAQ]. Typeform hard caps; SurveyMonkey per-extra-response; Formstack per-form caps (not pooled) [CONFIRMED/INFERRED as labeled].

---

## 6. User Journeys

```text
Visitor → Sign up → Onboarding → Create workspace → Create form → Template/blank →
Build → Logic → Notifications → Publish → Submission → Process → Collaborate →
Automate → Analyze → Export/integrate
```

| Step | Screen/concepts [CONFIRMED unless noted] | Primary action | Data / permissions | Friction / opportunity [INFERRED/RECOMMENDATION] |
|---|---|---|---|---|
| Visitor | Marketing + template gallery (20k+) | Browse/try | Anonymous view counts | Choice overload → AI/guided start |
| Sign up | Free Starter (5/100) | Register | Identity, ToS, region | Immediate cap anxiety → generous trial |
| Onboarding | Product tour, template picker, AI prompt | First form in <2 min | Intent, use case | Jotform AI exists but review-required → trusted defaults |
| Workspace | Teams (shared ownership; move personal→team transfers ownership, Team Admin only) | Create/invite | Membership, role | Starter–Gold team shell but invite/roles Enterprise-gated → **our wedge: multi-admin included** |
| Create form | Blank / template / AI / Smart PDF import / App | Choose entry | Template ID, source PDF | Smart-PDF equivalence is hard — plan early |
| Build | Add Element panel, pages, theme, CSS | Drag/drop/configure | Form schema JSON, field IDs | Autosave + undo + version history table-stakes; field-level ACL [UNKNOWN in Jotform] → opportunity |
| Logic | IF/THEN conditions, calc, skip, email/thank-you routing | Add rules | Rule graph | 180-condition scale anecdote → rule list + test-mode debugger |
| Notifications | Notification/autoresponder, Hide-Empty, webhook | Configure recipients | Email templates, secrets | Hidden-field leakage confusion → preview-with-sample-data |
| Publish | Link/embed/QR/email, custom domain, schedule/caps | Go live | Public slug, embed code, CSP | Lightweight embed SLA (Typeform perf complaints) |
| Submission | Public renderer (classic/card), prefill, save-continue, offline/kiosk | Fill + submit | Answer map, files, IP/device, consent | Spam/abuse → CAPTCHA, rate-limit, quarantine |
| Process | Inbox (tags/comments/share) → Tables (status, filter, lock, edit) | Triage | Status, tags, assignment | No native single-user assignment → first-class assignee + SLA |
| Collaborate | Teams roles; table Read/Comment/Collaborate; workflow tasks | Invite/comment/assign | Membership, grants, audit | Field-level perms + unified audit log missing → build in |
| Automate | Workflow elements, integrations, webhooks, API | Connect/approve | Execution runs, tokens | Clone-safe integration carryover (Tally complaint) → copy-with-mapping |
| Analyze | Report Builder, Enterprise analytics, GA/UTM | Dashboard/share | Aggregates, PII flags | Native drop-off + scheduled reports gaps → build both |
| Export | CSV/Excel/PDF, backup, Drive/Dropbox sync | Export | Export job, redaction | Permission-gated exports + DLP |

---

## 7. Multi-User / Collaboration Recon

Jotform model [CONFIRMED — teams/, help/guide-jotform-teams, teams/faq, answers threads]: shared workspaces owning forms/tables/reports/apps; invite by email; **full collaboration requires Enterprise** (Starter–Gold create shell but invite/roles gated); roles Team Admin / Creator / Data Collaborator / Data Viewer; table roles Read Only / Commenter / Collaborator (collaborator incl. delete); Lock Column/Filter; assignee-filtered views; Inbox comments/tags/share; workflow Assign Task + approvals; audit via Sign trail + Flow Reports + Admin Console/Workspace Insights (unified form-edit audit [UNKNOWN]); field-level ACL not documented [UNKNOWN].

Comparator pattern: Typeform 1/3/5 seats by tier; Tally unlimited members Pro+; Fillout unlimited seats all tiers (wins praise); Formstack 1/3/custom; Paperform unlimited; Feathery/Formbricks unlimited seats w/ RBAC-SSO paid [CONFIRMED — pricing recon].

**Preliminary permission model for OUR product (research only, not implemented):**

```text
User ──< Membership >── Workspace (org/team)
Membership: { user_id, workspace_id, workspace_role, created_by, mfa_status }
Workspace roles (progressive): Owner > Admin > Builder > Data Collaborator > Viewer (+ Billing contact flag)
Resource grants (override/additive, deny never implicit-allow):
  Form: { view, edit_schema, publish, view_submissions, edit_submissions, delete_submissions, export, manage_integrations }
  Table/View: { view, comment, edit_cells, manage_view, share }
  Workflow: { view, run, approve, manage }
  App/Report/Document: { view, edit, share }
Submission-level: assignee_id + status + private notes; row-level policy (assignee OR role>=data-collaborator).
Sharing: invite link w/ expiry + domain-allowlist; public renderer governed by form.published + rate limits, never by membership.
Audit: every grant/deny/schema/publish/export/approval/assignment → AuditLog (actor, action, resource, diff, IP/device).
```

Why: fixes the three confirmed gaps — (1) multi-admin paywall, (2) no native submission assignment, (3) no unified/field-level audit — while staying RLS-expressible [RECOMMENDATION].

---

## 8. User Complaint / Pain-Point Research (patterns only, multi-source 2024–2026)

Full evidence table in subagent transcript; headline patterns [CONFIRMED multi-source]:

1. **Pricing — Typeform volume punishment** ($28–39 for 100/mo; $79–89 for 1k; free 10/mo). SMB/lead-gen. Opportunity: pooled/annual responses, transparent per-workspace.
2. **Pricing — SurveyMonkey hostage data** (pay to view >25 responses; $0.15/extra; "expensive" 116× on G2). Casual/nonprofit. Opportunity: view/export everything even on free.
3. **Pricing — Jotform caps** (5/100 free; payment subs 10/100/250/1k; ~$9k/yr anecdote for 10 users Ent). Events/commerce/teams. Opportunity: pool limits, higher payment caps, sane team pricing.
4. **Pricing — Formstack $99 floor, no free; per-form (not pooled) caps.** SMB. Opportunity: $0–29 starter.
5. **Pricing — Paperform response ceilings escalate** (30 → 1.2k/yr → 12k/yr). DTC. Opportunity: annual-pooled limits + cheap top-ups.
6. **Limits — free-tier walls everywhere.** First-time users. Opportunity: ~1k/mo free wedge (Tally-level generosity) + no data hostage.
7. **Forms — Google Forms missing primitives** (no payments, caps, weak logic/branding, 17 vs 10k+ templates). Graduates. Opportunity: free UX + payments + logic + branding.
8. **Forms — Typeform one-at-a-time fails long/ops forms** (40-Q intake "takes forever"). Ops/HR/research. Opportunity: hybrid conversational + dense single-page per section.
9. **UX — Jotform bland/dated output, branding-removal confusion** (footers/emails persist). Agencies. Opportunity: modern theming, font control, true mid-tier white-label.
10. **UX — Formstack customization ceiling + learning curve** (14 G2 mentions). Non-technical/Salesforce-adjacent. Opportunity: power + approachability.
11. **Perf — Typeform embeds hurt speed** (Lighthouse ~20% claims; mobile penalty). DTC/SEO. Opportunity: <50kb lazy embed SLA.
12. **Mobile — multi-page fragility** [SINGLE-REPORT, watch]: Fillout page-transition mobile errors; Typeform mobile embed complaints. Field/frontline. Opportunity: mobile-first + offline/resume.
13. **Collab — team gated to Enterprise / per-seat tax** (Jotform/Typeform multi-user = custom Ent; free collab capped). Teams 5–50. Opportunity: unlimited seats paid, granular perms mid-tier — **core wedge**.
14. **Integrations — brittle** (Tally lost integrations on duplicate; Typeform HubSpot/Salesforce mapping errors, no native lead routing). RevOps. Opportunity: deep native CRM sync + safe duplicate-with-carryover.
15. **Data — Tally thin backend** (spreadsheet-only ops, no public results, weak notifications). Power users. Opportunity: built-in tables/dashboards/shareable reports/edit-after-submit.
16. **Support — SurveyMonkey auto-renew/no-refund** (Trustpilot/BBB pattern). Individuals. Opportunity: reminders, one-click cancel, pro-rata refunds — trust wedge.
17. **Support — Jotform quality decline + billing shocks** (r/jotform, Trustpilot, BBB 27/3yr). SMB. Opportunity: 24/7 human + billing transparency.
18. **Support — Formstack weak support at premium** (G2 top-5 con). Mid-market. Opportunity: white-glove onboarding at mid price.
19. **Enterprise — HIPAA tax** (Jotform Gold-only; Tally no BAA). Clinics/edu/gov. Opportunity: affordable BAA + audit <$50 tier.
20. **AI — upsell without value** (price up, caps tighten; add-ons feel bolted-on). Cost-sensitive. Opportunity: AI that cuts cost (generation, spam-filter, partial-recovery) included, not gated.
21. **Trust — Fillout thin trust + churn** (~30 G2 reviews; plan rename confusion; cap surprises). No-code/Airtable. Opportunity: clear limits + migration tooling.

---

## 9. Product Gap Analysis

### Table A — Feature parity (P0/P1/P2/P3/P4)

| Capability | Jotform | Typeform | Tally | Fillout | Others | Our platform (target) | Priority |
|---|---|---|---|---|---|---|---|
| Visual builder + templates | Yes (20k+) | Yes | Yes (100+) | Yes | Paperform/Formstack yes; Google 17 | Own builder on JSON schema | P0 |
| Field system (30+ types) | Yes | Yes | Yes | Yes | — | Schema-driven registry | P0 |
| Conditional logic + calc | Yes | Yes | Yes | Yes | — | Rule engine + test mode | P0 |
| Public renderer + prefill + save-continue | Yes | Yes | Yes (+piping) | Yes | — | SSR-safe, lightweight embed | P0 |
| Submissions inbox + tags/comments | Yes | Partial | Basic | Yes | — | Inbox w/ assignee + SLA | P0/P1 |
| Tables (views/filter/share/perms) | Yes | Partial | No (sheets-only) | Partial | — | First-class, shareable views | P0/P1 |
| Workflows/approvals/tasks | Yes | Add-ons | Basic | Yes | Formstack Suite yes; Feathery strong | Visual builder v1 | P1 |
| Notifications (email/webhook) | Yes | Yes | Email+webhook | Yes | — | Event bus + templates | P0 |
| Payments | 40+ gateways | Stripe (Biz+) | Stripe free | Free no-commission | Paperform 0% | Stripe-first, multi-gateway later | P1/P2 |
| E-signatures | Sign + audit | Gated | Free basic | Starter+ | Formstack unlim Suite | P2 (provider or own) | P2 |
| PDF gen/edit + Smart PDF | Yes | No | No | AI PDF-to-form | Formstack doc-gen | Gen first, Smart-PDF later | P2/P3 |
| Reports/analytics + drop-off + scheduled | Builder + Ent; drop-off/schedule gaps | Insights + drop-off (high) | Visit + drop-off (Pro) | Conversion/partial (Biz) | — | Native drop-off + schedules v1 | P1/P2 |
| Apps/portals | Yes (800+) | No | No | Higher tiers | Feathery OS | P3 | P3 |
| Integrations directory + webhooks + API | 150–200+, quotas | 500+ via Zapier | Native few + MCP | 50+ + REST | Formstack 300+ | Webhooks + REST + keys first | P0/P1 |
| Mobile/offline/kiosk | Yes (offline + kiosk) | Embed issues | Responsive | Fragile [single] | — | Responsive + offline-cache PWA | P1/P2 |
| Multilingual + accessibility | Translate; a11y [UNKNOWN depth] | Yes | 45+ lang + RTL | — | — | i18n + WCAG 2.2 AA from day 1 | P1 |
| AI (generate/edit/agents/insights) | Yes (review-required) | Create + Clarify | Gen+fix (competitor claim) | Gen + PDF-to-form | Feathery Robin/doc-intel | Generate + assist + spam/partial (guardrailed) | P2 (P4 agents) |
| Teams/RBAC/audit/SSO/residency | Ent-gated; audit partial | Seats/SSO Ent | Members Pro+; no BAA | Unlimited seats; SSO/perm Ent | Formstack Ent; Feathery RBAC/SSO paid | Multi-admin + audit + SSO/residency path | P0 |

### Table B — Differentiation (evidence-backed, not manufactured)

1. **Multi-admin included** — every competitor gates real teams to Enterprise/custom; Fillout/Tally win praise for unlimited seats. Ship workspace + granular RBAC on paid self-serve [RECOMMENDATION].
2. **Fair metering** — pooled annual responses, no hostage data, cheap top-ups; Typeform/Jotform/SurveyMonkey caps are the #1 complaint cluster [RECOMMENDATION].
3. **Submission collaboration done right** — first-class assignee, SLA, private notes, status, unified audit (Jotform lacks native single-user assignment [CONFIRMED]) [RECOMMENDATION].
4. **Hybrid layouts** — conversational *or* dense per-section (Typeform fatigue evidence) [RECOMMENDATION].
5. **Lightweight embed + mobile/offline SLA** — measurable <50kb lazy-load + offline queue (Typeform perf + kiosk evidence) [RECOMMENDATION].
6. **Clone-safe integrations** — mapping survives duplicate/template; deep CRM sync (Tally/Typeform brittleness evidence) [RECOMMENDATION].
7. **Trust billing** — reminders, one-click cancel, pro-rata, no auto-renew traps (SurveyMonkey/Jotform evidence) [RECOMMENDATION].
8. **Affordable compliance path** — BAA + audit + SSO below Enterprise tax (HIPAA-tax evidence) [RECOMMENDATION].
9. **Builder speed + test mode** — rule debugger, version history, keyboard/command-palette (scale anecdote: 180 conditions) [RECOMMENDATION].
10. **Dev experience** — clean REST + webhooks + keys + OpenAPI + MCP from day 1, generous quotas (Jotform 1k–100k/day tiered evidence) [RECOMMENDATION].

---

## 10. Form Engine Evaluation

Method: engine subagent fetched GitHub API + npm (2026-10-27) + official docs; no installs. Numbers [CONFIRMED] at fetch date; docs claims as labeled.

| Engine | License | React/Next | Builder? | Schema | Logic | Validation | Theming/a11y | Perf/SSR/mobile | Community (stars/push/issues; npm/mo) | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| SurveyJS (`survey-library`) | MIT library; **Creator/Dashboard/PDF commercial** (~$589–$2,359/dev + EULA non-compete language) | `survey-react-ui` + `survey-core`; Client comp | **Yes (paid)** | Proprietary JSON | visibleIf/enableIf/triggers/calc | Built-in validators | Tokens/CSS vars/themes; 50+ locales/RTL/kb | Good (lazy-load Creator); client render; responsive + signature/file/capture | ~4.9k, today, 446; ~1.24M/mo | Fastest path **iff** legal clears EULA + finance accepts per-dev fee |
| JSON Forms | MIT | React/Vue/Ang; Client comp | **No** (prototypes only) | JSON Schema + UI Schema | UI-rule SHOW/HIDE; `if/then`/`oneOf` | AJV | Material/vanilla + custom renderers | Good; dynamic import; theme-dependent | ~2.75k, 2026-10-26, 156; ~1.20M/mo core | Cleanest standards bet; 100% DIY builder |
| React Hook Form | MIT | First-class React 18/19 + App Router (Client) | **No** (headless) | None (register + Zod/Yup) | Code (`watch`) | Built-in + resolvers | Unstyled (any DS) | **Best-in-class** (uncontrolled); tiny; RN-ready | ~44.9k, today, 10; ~205M/mo | Default headless; pair with Zod + own schema/renderer/builder |
| Form.io (`formio.js`) | MIT renderer; **platform commercial** ($330–$660/mo/env; builder module $660; a11y add-on $495/mo) | Vanilla + React wrapper (App Router friction; `ssr:false`) | **Yes (closest to Jotform; white-label paid)** | Proprietary | Declarative conditional + calc + actions | Built-in + hooks | Bootstrap default (dated) | Heavy; client-only; offline/PDF-first strength | ~2.1k, today, 215; ~178k/mo | Viable only if embracing their commercial stack — perverse for a disruptor |
| Uniforms | MIT | React-first (AntD/Bootstrap/MUI) | No | JSON Schema/Zod/Yup/GraphQL bridges | Schema + code | Via bridge | Theme pkgs | Light; client; theme-dependent | ~2.1k, **~9 mo stale (2026-01)**, 30; ~89k/mo | **Reject** — maintenance risk |
| Formik | Apache-2.0 | React (effectively maintenance) | No | Code-first | Code | Yup-first | Unstyled | Heavier re-renders vs RHF | ~34.3k, stale (2025-11), 843; ~17M/mo | **Reject** for new 2026 work — RHF dominates slot |
| Final Form | MIT-claimed (`NOASSERTION` on API — verify file) | Core + `react-final-form` (R19 freshness [UNKNOWN]) | No | Code-first + subscriptions | Code | Record/field fns | Unstyled | Very good (subscriptions) | ~3k core, 2026-05, 105; ~2.4M/mo | Fallback headless only |
| RJSF | Apache-2.0 | React 16+; App Router via Client [INFERRED, very active 2026] | **No** (playground only) | **Pure JSON Schema + `uiSchema`** | `dependencies`/`if-then`/`oneOf` + ui rules | AJV8 (`@rjsf/validator-ajv8`) | Theme pkgs (default/AntD/MUI/Chakra/shadcn-community) | Moderate-heavy on huge schemas (AJV); client bundle | ~15.9k, today, 111; ~4.24M/mo | **Healthiest truly-open schema renderer; default if JSON-Schema-portable** |
| Tally/Typeform embeds | Proprietary SaaS | Iframe/SDK | Their builder | N/A | Hosted | Hosted | Iframe-constrained | Extra weight | N/A | **Strategic non-starter** for a competitor |

**Ranked recommendation [RECOMMENDATION]:**

1. **RJSF + React Hook Form + Zod hybrid** — portable JSON Schema definitions (RJSF renders schema-driven/dynamic forms; RHF+Zod for hand-tuned surfaces), all Apache-2.0/MIT, biggest combined ecosystem (~209M/mo), full shadcn/UX ownership, no per-env pricing. Cost: you build the visual builder — but the builder *is* the moat. Pre-spike: RJSF v6 Client Component + AJV8 + one custom widget/theme; RHF+Zod dynamic-field + dnd prototype; verify R19 peers + AJV split.
2. **SurveyJS (MIT lib + paid Creator)** — fastest credible builder-backed MVP (builder + themes + dashboard + PDF exist today). Only if legal clears the EULA non-compete for a competing builder *and* finance accepts per-dev licensing; isolate SurveyJS JSON behind an adapter for future migration.
3. **JSON Forms** — fallback if JSON-Schema + UI-Schema purity outranks community size; same DIY-builder cost with smaller hiring pool (~2.75k stars).

Explicit non-picks: Formik/Final Form (stagnant vs RHF); Uniforms (dependency risk); Form.io foundation (pricing + commercial steering vs our model); third-party embeds (reselling a competitor).

---

## 11. Preliminary Domain Model (hypotheses — no migrations)

```text
User { id, email, name, avatar, mfa, locale, created_at }
Workspace { id, slug, name, plan, region, settings }
WorkspaceMember { user_id, workspace_id, workspace_role, invited_by, mfa_required }
Invitation { id, workspace_id, email, role, token_hash, expires_at, accepted_at }
Role/Permission { role, scope(resource, action) } — seeded roles + custom grants (see §7)
Form { id, workspace_id, slug/public_id, title, status(draft/published/archived), layout(classic/card/hybrid), renderer_version, settings(captcha, schedule, caps, locale, theme_ref), created_by }
FormVersion { id, form_id, version_no, schema_json, ui_schema_json, rules_json, published_at, published_by, changelog } — immutable on publish; renderer pins version
FormField (derived/materialized from schema for querying) { id, form_version_id, key, type, required, config_json, order } — OR virtual-only; prefer virtual + index on submission answers [decision for ARCH phase]
FormTheme { id, workspace_id, tokens_json, fonts, branding, custom_css }
FormPublication { id, form_id, version_id, channel(link/embed/qr), slug, config, views_count }
Submission { id, form_id, form_version_id, respondent_key, status(new/in_progress/assigned/approved/rejected/spam), assignee_id, locale, channel, ip_hash, user_agent, geo, consent, completed_at }
SubmissionValue { submission_id, field_key, value_json } — OR jsonb answers on Submission; relational row per field aids reporting but costs write amplification [ARCH decision]
SubmissionAttachment { id, submission_id, field_key, storage_path, mime, size, scan_status }
SubmissionAssignment { id, submission_id, assignee_id, assigned_by, sla_due, status }
SubmissionStatusHistory { submission_id, from, to, actor, at, note }
SubmissionComment { id, submission_id, author_id, body, mentions, created_at }
SubmissionTag { submission_id, tag } + Tag { workspace_id, name, color }
TableView { id, form_id, name, type(grid/cards/calendar/uploads/report), config_json(filters/sorts/groups/hidden), shared, lock_config, created_by }
Workflow { id, workspace_id, trigger(form_submitted|manual|schedule), status }
WorkflowNode { id, workflow_id, kind(approval/task/payment/sign/email/condition/integration), config_json }
WorkflowEdge { id, workflow_id, from, to, condition_json }
WorkflowExecution { id, workflow_id, submission_id, status, context_json, started/completed_at }
WorkflowTask { id, execution_id, node_id, assignee_id, status, due_at, decided_at, decision }
Integration { id, workspace_id, provider, config_json, status } + IntegrationRun { id, integration_id, submission_id, status, request/response refs }
Webhook { id, workspace_id|form_id, url, secret, events, active } + WebhookDelivery { id, webhook_id, event, payload_ref, status, attempts, next_retry }
APIKey { id, workspace_id, name, prefix, hash, scopes, expires_at, last_used } + OAuthClient (later)
Document (Sign/PDF) { id, workspace_id, submission_id, template_ref, status, recipients_json, audit_trail_json, signed_pdf_path }
Payment { id, submission_id, provider, amount, currency, status(pending/authorized/captured/refunded/failed), provider_ref, subscription_ref } + PaymentEvent { payment_id, event, payload }
Report { id, workspace_id, form_ids, config_json, schedule_cron, last_run } + ReportRun { id, report_id, output_path, stats }
Dashboard { id, workspace_id, widgets_json } (drop-off, conversion, volume)
App { id, workspace_id, name, slug, branding_json } + AppPage { app_id, kind(form/table/report/link), ref_id, order, visibility }
Template { id, scope(global/workspace), category, schema_snapshot, preview, locale }
Notification { id, workspace_id, channel(email/sms/push), template, rules } + NotificationLog
AuditLog { id, workspace_id, actor_id, action, resource_type/id, diff_json, ip/device, at } — append-only
Plan/Limit counters { workspace_id, period, forms, submissions, views, uploads_bytes, payments, sign_docs, api_calls, ai_units } — metered enforcement
```

Why each exists: Users→Workspaces→Members/Invitations/Roles model the wedge (multi-admin included); Form+Version immutability enables safe publish/rollback + renderer pinning; Submission* family separates answers (hot, JSON-friendly) from collaboration (relational: assignment/status/comments/tags/history); TableView persists shareable filtered views; Workflow* separates definition/graph from executions/tasks (audit + retry); Integration/Webhook/APIKey separate config/secrets/delivery; Document/Payment capture regulated side-effects with trails; Report/Dashboard/App/Template/Notification cover analyze/publish/reuse/notify; AuditLog + counters enforce trust-billing + fair metering [RECOMMENDATION].

JSON-vs-relational rule of thumb: schema/rules/UI/theming/widgets/notifications/audit-diff as JSON; identity/membership/forms/versions/submissions/assignments/tasks/payments/documents/keys/deliveries/logs as relational with FK + RLS [RECOMMENDATION — validate in ARCH].

---

## 12. Multi-Tenancy Architecture Proposal (research only)

```text
User → Workspace → Membership → Role → Permission → Resource
```

- **Auth:** Supabase Auth (or equivalent OIDC) for identity + MFA + SSO(SAML/OIDC) at team/enterprise tiers; service-role only on server; anon key never bypasses RLS [RECOMMENDATION; Supabase Auth + Postgres + RLS explicitly named in brief].
- **Isolation:** single Postgres DB, `workspace_id` on every tenant row + RLS `USING (workspace_id IN (member workspaces))` + `WITH CHECK`; public submission path uses scoped RPC/service function with form-published check + CAPTCHA + rate limit — never direct table insert from anon [RECOMMENDATION].
- **Roles:** workspace_role (owner/admin/builder/data/viewer) + per-resource grants table; RLS policies check membership join + grant; explicit deny-by-default; field-level redaction in application layer (RLS can't easily do per-column per-row at scale — select via views/RPC) [INFERRED best practice].
- **Service boundaries:** Edge/BFF → API (RLS user context) → workers (service-role, tenant-scoped by `workspace_id` param + audit) → storage (per-workspace prefix `w/{workspace_id}/...`, signed URLs, AV scan) → outbound (webhooks/integrations with per-workspace secrets in vault, never in DB plaintext) [RECOMMENDATION].
- **Public surface security:** unguessable `public_id` + optional slug; published-only reads; submission caps/schedule/unique-field checks server-side; honeypot + Turnstile/reCAPTCHA; per-IP/form throttling; file type/size enforcement + quarantine; spam scoring; PII minimization (IP hash, retention delete like Tally Business) [RECOMMENDATION].
- **Storage/files:** isolated prefix, content-type sniffing, AV scan status gate before serving, signed-URL expiry, total/upload caps metered per plan [RECOMMENDATION].
- **Secrets:** API keys stored as hash + prefix; webhook secrets HMAC-signed payloads; OAuth tokens in vault with rotation; gateway keys per-workspace encrypted; audit all secret access [RECOMMENDATION].

---

## 13. Security Threat Model (preliminary)

| # | Threat | Mitigation | Phase |
|---|---|---|---|
| T1 | Cross-tenant read/write (IDOR, missing RLS) | RLS on all tenant tables + deny-by-default; tenant-ID from session, never client param; per-resource grant checks; integration tests per role | P0 |
| T2 | Privilege escalation (self-promote, invite abuse) | Invite tokens hashed + expiry; role changes require admin + audit; transfer-ownership flow; domain-allowlist | P0 |
| T3 | Public form abuse (spam, bot flood, content) | CAPTCHA/Turnstile, rate limit per IP/form, honeypot, file quarantine, spam status, abuse report + takedown | P0 |
| T4 | Malicious uploads (malware, polyglot, SVG XSS) | Allowlist MIME + sniffing, AV scan, sandbox serve (`Content-Disposition: attachment`, no-sniff), size caps, signed URLs | P0 |
| T5 | Stored/reflected XSS via answers/themes/CSS | Output-encode renderer; sanitize rich text; CSP; custom CSS sandboxed/reviewed; SVG stripped | P0 |
| T6 | CSRF on state-changing web actions | SameSite cookies + anti-CSRF tokens for cookie auth; prefer bearer for API | P0 |
| T7 | Webhook SSRF / secret leak | URL allowlist + no private-IP egress, timeouts, HMAC signatures, redacted logs, retry with backoff | P1 |
| T8 | API key/OAuth theft, over-scoped tokens | Hashed storage, prefix display, scopes + expiry, rotation, last-used, vault for OAuth, anomaly alerts | P0/P1 |
| T9 | Payment fraud / PCI scope | Never store PAN; gateway-hosted fields/Elements; idempotency keys; webhook signature verify; reconcile-then-fulfill | P1 |
| T10 | E-sign repudiation / doc tampering | Hash + tamper-evident audit trail (open/view/sign/delegate/complete, IP/device/MFA/geo), completed-PDF immutability | P2 |
| T11 | Excess exports / data exfiltration | Export permission + approval for bulk, redaction options, DLP flags, export audit + watermark | P1 |
| T12 | Retention/GDPR deletion failure | Retention policies (auto-delete like Tally Business), hard-delete flows, backup purge windows, DSR export | P1 |
| T13 | AI prompt-injection / PII leak via AI | AI on allowlisted fields, PII redaction, human review gate, provider DPA, no training on tenant data, audit AI actions | P2 |
| T14 | Workflow runaway / privilege confusion | Execution sandbox, per-step authz (approver ≠ requester), idempotent nodes, run audit, kill-switch | P1 |
| T15 | Tenant crypto/region confusion (HIPAA/residency) | Region-pinned DB/storage, BAA-gated AI model routing (cf. Jotform GPT-4 vs Vertex/Gemini split [CONFIRMED]), key separation | P2/Ent |

---

## 14. Performance Considerations

Likely hot spots [INFERRED/RECOMMENDATION]: builder (huge schemas + 180-rule graphs) → virtualize canvas, lazy-load Creator-equivalent, web-worker rule evaluation, autosave debounce + OT/collab throttling, undo snapshots capped; public renderer → SSR shell + client islands, code-split per field type, <50kb critical embed, edge-cache published schema, prefill via URL without extra round-trip; uploads → direct-to-storage multipart + resumable + AV async; ingestion → queue (submissions → fan-out: search index, notifications, webhooks, workflow trigger) with idempotency; tables (100k rows) → server pagination + column projection + saved-filter materialization + read replicas; workflows → durable execution (step checkpoints, retries, dedupe); analytics → pre-aggregated counters + rollups, not scan-on-read; realtime collab → presence + patch, not full-schema broadcast.

Strategies: JSON schema cached at edge keyed by `(form_id, version)`; answers as `jsonb` + GIN on hot keys, relational side-tables for assignment/status; rate-limit + queue public writes; isolate AI/exports to workers; budget: LCP <2.5s renderer, INP <200ms builder interactions, p95 submission accept <500ms (excl. upload) [RECOMMENDATION targets for ARCH to ratify].

---

## 15. Design System Observations (patterns, not copying)

Reusable Jotform-category patterns [OBSERVED]: left field palette / center canvas / right inspector; responsive + conversational preview toggle; command palette + shortcuts; drag/drop; autosave + undo/redo + version history; publish flow (link/embed/QR/email/domain); inbox triage (filter → tag → comment → assign → status); table views (filter/group/sort/lock/share); workflow canvas (add-element + outcome branches); report auto-charts. Our identity must be original — no logos/colors/illustrations/copy/assets [RECOMMENDATION]. Accessibility: WCAG 2.2 AA from day 1 (contrast, focus, keyboard builder ops, screen-reader announcements for logic errors) — depth [UNKNOWN] in Jotform, hence an opening.

---

## 16. Feature Dependency Graph

```text
Authentication
      ↓
Workspace (plan, region, settings)
      ↓
Membership + RBAC (+ invitations, audit)
      ↓
Form Schema (JSON) + Versions (immutable) + Themes
      ↓
Form Builder (palette/canvas/inspector, rules, i18n, a11y)
      ↓
Renderer (public, prefill, save-continue, offline queue, embed)
      ↓
Publishing (slug/domain/schedule/caps) + Notifications (email)
      ↓
Submissions (ingest→validate→quarantine→store→attach)
      ↓
Submission Inbox (search/filter/tags/comments/assign/status)
      ↓
Tables (views/share/perms/edit/export)
      ↓
Workflow Engine (triggers/nodes/edges/executions/tasks)
      ↓
Integrations (directory/runs) + Webhooks (deliveries) + API (keys/quotas)
      ↓
Payments / Sign / PDF (regulated side-effects, trails)
      ↓
Apps/Portals (composition) + Reports/Dashboards (aggregates)
      ↓
AI (generate/assist/analyze — last: needs stable schema + data + guardrails)
```

Corrections to naive ordering: RBAC *before* builder (every resource needs grants from row one); Versions *before* publishing (renderer pins version); Inbox *before* Tables depth (triage precedes analysis); API/webhooks *before* payments/sign (side-effects need eventing + idempotency); AI *last* (needs schema + data + redaction + review gates) [RECOMMENDATION].

---

## 17. MVP / V1 / V2 / V3 / Enterprise (smallest product that proves architecture + why a team switches)

### MVP — "The teams product that proves the architecture" [RECOMMENDATION; P0 only]
Auth (email + MFA) → Workspace + invitations + 4 roles + resource grants + audit → JSON-schema forms (10–12 field types: text/long/radio/checkbox/dropdown/number/email/phone/date/file/signature-mvp/hidden) + versions (immutable publish) + themes (tokens, no custom CSS yet) → Builder (palette/canvas/inspector, undo, autosave, basic i18n) + rule engine v1 (show/hide, require, skip-page, email/thank-you routing, calc) + test mode → Renderer (link + lightweight iframe embed, prefill URL, save-continue, rate-limit + CAPTCHA) → Submissions ingest + Inbox (search/filter/tags/comments/**assignee + status + SLA** + history) → Tables v1 (grid, filter/sort, inline edit, share w/ Read/Comment/Collaborate, CSV export) → Webhooks + REST v1 (keys, scopes, quotas, OpenAPI) → counters/metering + admin billing hooks. Explicitly out: workflows, payments, sign, smart-PDF, apps, AI. Why switch: multi-admin included + fair metering + assignment/SLA + light embed from day one.

### V1 — Launch-critical [P1]
Workflows v1 (approval/task/email/condition/integration nodes + executions + reminders), notifications center, scheduled + drop-off analytics, scheduled/CSV+Excel+PDF exports, offline response queue + PWA install, multilingual forms, HIPAA-ready posture (BAA, retention delete, audit hardening), Stripe-first payments, native e-sign v1 (single + sequential, audit trail), PDF generation from submissions, 10–15 native integrations (Sheets/Drive/Slack/CRM-first), SSO (Google/Microsoft/SAML), custom domains.

### V2 — Important [P2]
Subscriptions/donations/tax/coupons/refund flows + 2nd gateway; parallel signing + delegation + templates; Smart-PDF-equivalent import; conversational/hybrid layouts; portals/apps v1; report schedules + dashboards; AI v1 (prompt-to-form, chatbot edit, spam/partial recovery, AI insights — guardrailed, review-required); Salesforce/HubSpot deep sync; white-label; data residency option.

### V3 — Later [P3]
App marketplace + templates economy; advanced portals (auth-gated); doc-intel/IDV/KYC-grade verification; meeting/escalation apps; multi-language AI agents; usage-based billing + top-ups; public results/reports sharing; field-level ACL GA.

### Enterprise [gated]
SSO/SAML/SCIM, residency (EU/US), BAA + DLP, custom API domain, Admin Console + Workspace Insights equivalents, audit export/SIEM, white-label mobile, CSM/SLA, procurement (MPA/DPA, pen-test reports).

---

## 18. Repository Impact

- **State:** empty directory, no framework/package-manager/DB/tests/CI/CD present [OBSERVED 2026-10-28]. Nothing to migrate; greenfield.
- **Implication:** ARCH phase chooses Next.js App Router + React + TypeScript + shadcn-equivalent DS + RHF/Zod + RJSF (per §10), Postgres (+RLS) with Supabase Auth or equivalent, storage + queues + workers; sets monorepo layout, `docs/arch/`, ADRs, and `docs/recon/` retention. No action taken in this phase per stop condition.

---

## 19. Risks

1. **Scope creep (15 products in one)** — mitigate with dependency graph (§16) + MVP fence (§17).
2. **SurveyJS/Form.io license traps** — EULA non-compete / per-env pricing; mitigate via RJSF+RHF+Zod default + legal review before any commercial-builder touch.
3. **RLS/IDOR miss on day one** — mitigate with deny-default policies + per-role integration tests + tenant-from-session rule.
4. **Public-surface abuse** — spam/flood/malware; mitigate with caps/CAPTCHA/quarantine/AV/signed URLs.
5. **Payments/Sign compliance underestimation** — PCI/ESIGN/UETA/audit-trail depth; mitigate by gateway-hosted + tamper-evident trails, counsel review.
6. **AI over-promise** — accuracy/retention/BAA routing (cf. Jotform GPT-4 vs Vertex split); mitigate with redaction + review gates + provider DPAs.
7. **Billing trust** — auto-renew/refund/cap surprises are top complaints; mitigate with reminders, one-click cancel, pro-rata, transparent meters.
8. **Embed perf + mobile** — measurable SLA or repeat Typeform's mistake; mitigate with budgets + device-lab + offline tests.
9. **Integration brittleness** — duplicate-breaks-mapping; mitigate with carryover-safe clone + mapping UI + delivery logs.
10. **Geo-pricing volatility** — several figures geo-variant (SurveyMonkey INR fetch); re-verify before quoting externally.

---

## 20. Open Questions (for ARCH-001)

1. Supabase-hosted vs self-hosted Postgres + Auth — residency/SSO/cost trade-off?
2. Answers as `jsonb` vs per-field rows — reporting vs write-amplification at 100k subs/form?
3. Realtime collab primitive (Yjs/Liveblocks/self-built patches) for builder + Tables co-edit?
4. Workflow durability primitive (Temporal/Inngest/pg-boss/custom) + idempotency envelope?
5. File pipeline (direct-upload + AV vendor + retention) and per-plan caps math?
6. Public renderer SSR strategy (RSC shell + islands) vs full-client with edge-cached schema?
7. AI provider routing (standard vs BAA/HIPAA) + redaction + eval harness?
8. E-sign build-vs-buy (own audit-trail engine vs provider) and ESIGN counsel?
9. Smart-PDF-equivalent scope — V2 full import vs V3?
10. Quota/counter store (Postgres vs Redis) + enforcement points (ingest, API, AI, exports)?

---

## 21. Recommended Next Step → FORMOS-ARCH-001

Architecture phase should ratify: (a) engine spike winner (RJSF+RHF+Zod vs SurveyJS-legal-cleared), (b) tenancy/RBAC/RLS policy set + threat-model sign-off, (c) domain model v0 + JSON-vs-relational lines, (d) dependency-graph build order + MVP fence, (e) perf budgets + embed SLA, (f) billing/meters + trust-billing rules, (g) ADR index. No code, no migrations, no engine install until ADRs signed.

---

## Tools / Skills Used

| Tool / Skill | Purpose | What it contributed |
|---|---|---|
| `read` (local) | Repo inspection | Confirmed empty workspace — greenfield, no framework/DB/tests/CI |
| `shell` (Get-ChildItem) | Repo verification | Double-confirmed emptiness (Windows-safe listing) |
| `execute` + `search` (Code Mode catalog) | MCP/tool discovery | Enumerated browser-use / playwright / rea / opencode tools |
| `subagent` (general ×4, parallel) | Delegated recon tracks | (1) Pricing matrix w/ official-page sources; (2) Form-engine eval w/ live GitHub/npm stats; (3) Pain-points w/ multi-source recurrence; (4) Jotform capability + API/RBAC/AI map w/ help-doc URLs |
| `webfetch` (direct) | Evidence verification | Fetched `jotform.com/pricing` (full tier/limit/AI-meter table), `api.jotform.com/docs` (auth/endpoints/quotas/SDKs), `tally.so/pricing` (free-fair-use + Pro/Business $24/$74) — confirmed subagent claims first-hand |
| `websearch` (via subagents) | Public reviews/docs discovery | Reddit/G2/Capterra/Trustpilot/BBB threads, vendor help/enterprise pages, GitHub/npm metadata |
| Available-skills index (`banner-design`, `brand`, `design`, `design-system`, `find-skills`, `opencode`, `report`, `reverse-engineer-anything`, `slides`, `ui-styling`, `ui-ux-pro-max`) | Skill discovery | Reviewed for relevance (none auto-invoked; dedicated recon/REA/design-system skills noted below) |

## Relevant Tools Discovered But Not Used

| Tool / Skill | Reason not used |
|---|---|
| `browser-use` / `playwright` (navigate/click/extract/screenshot) | No login-gated inspection needed; public docs + fetches sufficed; reserved for ARCH-phase UX walkthroughs if approved |
| `rea` (reverse-engineering toolkit) | Targets local artifacts/binaries — no shipped artifact in scope; clean-room web recon only |
| `reverse-engineer-anything` skill | Same — for binary/packaged/browser-runtime targets, none present in this phase |
| `ui-ux-pro-max` / `design-system` / `ui-styling` skills | Valuable for ARCH/design-system phase (tokens, palettes, component specs, builder layout patterns); premature before capability map |
| `report` skill | For filing opencode issues via `gh` — no product bug in scope |
| `opencode` skill | OpenCode self-host Q&A — irrelevant to competitor recon |

---

## Appendix — Key sources (directly verified or subagent-verified this round)

Pricing: `jotform.com/pricing` [CONFIRMED direct]; `tally.so/pricing` [CONFIRMED direct]; typeform/fillout/formstack/surveymonkey/paperform/feathery/formbricks/workspace pricing pages [CONFIRMED via subagent]. API: `api.jotform.com/docs` [CONFIRMED direct]; `jotform.com/developers`; `jotform.com/help/406-daily-api-call-limits`. Capabilities: `jotform.com/help/46-quick-overview-of-form-fields`, `/help/2-how-to-create-your-first-web-form`, `/help/57-smart-forms-conditional-logic…`, `/help/268…calculation`, `/help/434…hide`, `/help/71…prefill`, `guide-jotform-inbox`, `…/how-to-use-tags-in-jotform-inbox`, `…/660…assignee-submissions`, `chapter-139-jotform-tables`, `…/1009…filter`, `…/44…export-excel`, `guide-jotform-workflows`, `…payment-request…`, `…request-electronic-signatures…`, `…/323…payment`, `…/292…authorization`, `…/how-to-use-jotform-sign`, `products/sign/features/audit-trail`, `products/pdf-editor`, `products/smart-pdf-forms`, `products/report-builder`, `enterprise/features/forms/analytics`, `products/apps`, `integrations`, `integrations/webhooks`, `products/mobile-forms(+faq)`, `help/571…kiosk`, `help/how-to-use-jotform-ai`, `ai/form-builder`, `ai/agents`, `teams`, `help/guide-jotform-teams`, `teams/faq`, `enterprise/*`. Comparisons/reviews: Reddit (r/smallbusiness, r/nocode, r/jotform, r/marketing, r/hubspot, r/TallyForms, r/GoogleForms…), G2/Capterra/Trustpilot/BBB, vendor compare pages (`jotform-vs-tally-forms`, `tally.so/help/compare`, `fillout.com/vs/jotform`). Engine facts: GitHub API + npm registry (stars/push/issues/downloads, 2026-10-27) + vendor licensing pages (SurveyJS, Form.io). Full URL lists preserved in subagent transcripts above (§4 intro references).

*End of FORMOS-RECON-001.*
