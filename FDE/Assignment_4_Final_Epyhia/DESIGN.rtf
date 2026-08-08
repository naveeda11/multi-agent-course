{\rtf1\ansi\ansicpg1252\cocoartf2870
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fnil\fcharset0 HelveticaNeue;\f2\fnil\fcharset0 .AppleSystemUIFontMonospaced-Regular;
\f3\fnil\fcharset0 .SFNS-Regular_wdth_opsz110000_GRAD_wght1F40000;}
{\colortbl;\red255\green255\blue255;\red11\green11\blue11;\red251\green251\blue250;\red11\green11\blue11;
\red11\green11\blue11;\red251\green251\blue250;\red11\green11\blue11;}
{\*\expandedcolortbl;;\cssrgb\c4314\c4314\c4314;\cssrgb\c98824\c98824\c98431;\cssrgb\c4314\c4314\c4314\c3922;
\cssrgb\c4314\c4314\c4314;\cssrgb\c98824\c98824\c98431;\cssrgb\c4314\c4314\c4314\c3922;}
\margl1440\margr1440\vieww11520\viewh11820\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 The epyhia system is generating a specific type of business infrastructure and marketing from a prompt. \
\
On the backend, from a prompt, the epyhia system will\
\
Generate marketing website.\
\
The generated marketing websites are uploaded to Cloudflare. In a longer term infrastructure, this might be provisioned in Github on a per-repo basis but not in scope for this project. \
\
Currently 1 tenant is tied to 1 business. \
\
Sample Business\
Party Rentals - Local Party Rentals business for residential and small business events. The business rents tables, chairs, tents, generators, audio system for residential and small business use. Rentals are for specific quantities of items and for a fixed term. \
\
Business charges:\
\pard\pardeftab720\partightenfactor0

\f1\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 pay-in-full at booking:\'a0
\f2\fs26 \cb4 qty \'d7 day_rate \'d7 rental days per item\

\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Out of scope: late fees, customer alerts or reminders, backend delivery scheduling or worker tracking, security deposits. \
\
Flow 1 - Business Creation Flow (interactive - 2-5 minutes of time including human interactions)\
Administrator (me) logs in and in the Admin dashboard of epyhia, enters a business description prompt. \
\
The Orchestrator/Strategist checks the completeness of the prompt\
- data exists for initial population of business catalog (Ops agent does the dB write)\
\
If the prompt is considered incomplete, getting more information is done by interactively asking the user \
\
\
Orchestrator will generate a brand identity document\
The orchestrator creates an entry for business creation which consists of \
Business name, business id, and persists the brand doc, and creates a task list (status)\
\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
One that is done - then a dashboard view is created so that the user can see the status (brand document - pending, Web Builder: Pending, Maketing: Pending)\
\
Polling will happen in the background against this task table and then the dashboard is updated. \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
The web builder , using the brand doc, will be kicked off to start the task for HTML/CSS generation based on design criteria, That HTML/CSS is persisted, and then pushed to Cloudflare and a URL is returned and stored. The task table is updated. \
\
The marketer using the brand doc, will generate the marketing copy for the website along with marketing posts. Marketing posts will be stored in another DB table (segregated with tenant Id) and generate a story board. That is a human review, and if the story board is approved, then a video is generated (via Veo) . Marketing actions will need human review so the dashboard will reflect the need for human review. If editing is needed, the human can prompt for the change (max 5 Veo generations per tenant for both types of Veo renders) otherwise the task dashboard is updated and the marketing collateral is stored. Story board generation is cheaper then Veo, so splitting it to require one approval for story board and the other for Veo generation.\
The Vertical Cut video will be a 2nd Veo invocation. \
Veo Video Generation via {\field{\*\fldinst{HYPERLINK "https://github.com/kdowswell/veo-tools"}}{\fldrslt kdowswell/veo-tools}}\
\
Ops agent will be doing the initial population of the schema (including the tenant id) - this is also a task in the task list\
Note: The brief should consist of the items in the prompt. If the prompt does not include them, the orchestrator gets them, the orchestrator at the end gives a fully populated prompt. \
\
Flow 2 \
Business operations flow for party rental\
\
- Customer selects one or more items at public facing website for checkout \
- Initiates a backend call \
 - based on email loads or inserts customer row\
- which checks availability and inserts reservation with PENDING status. \
- Note that PENDING reservations count against availibility. \
- create Stripe checkout session (test mode) - idempotency key is derived from reservation ID and sent to Stripe. Stripe Session URL returned. \
- Stripe redirects back - web hook (
\f2\fs26 \cf2 \cb4 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 checkout.session.completed) 
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 is invoked which flips reservation to Confirmed. Stripe signature is verified when updating the reservation. \
\
\
Flow 3 - expired reservations cleanup\
Business Operations Flow for Expired Rentals (Abandoned checkout)\
If a customer reserves but never pays, we have abandoned checkouts. Use Stripe Checkout expiration web book to cancel those after 1 hr. \
\
\
\
Implementation Architecture\
\
Technical Stack\
Marketing website: Cloudflare Pages \
Epyhia backend: \
Node API Gateway\
Node backend workers\
Storage: Neon DB and Cloudflare R2 \
Authentication: Auth0 \
\pard\pardeftab720\partightenfactor0
\cf0 \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Two process groups\
1) web process group is available from the public internet\
2) gated process group contains API keys and is accessible only via the web process group. \
Gated processes are heavily integrated with human reviews before irreversible actions (aside from customer initiated spending)  . 
\f1\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 both process groups deploy to Fly.io; the gated app is private-network\'a0only, reachable solely from the web app
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 \
\
\
Deployment, marketing publishing, video rendering, LLM calls will be within the credentialed process group (audit and cost logging - not exposed to public web directly) \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 API Gateway (web process group)\
\
\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Action Code (gated) needs\
- run_id, tenant_id, agent_name, action, destination_url, destination_params, cost, approved_by, timestamp, idempotency_key, status (pending_approval, approved, executed, failed) and mode (test or live)\
/deploy will deploy to Cloudflare \
/ charge works against Stripe test mode\
/ publish - for video renders or social media and email\
\
Orchestrator, Marketer, Web Builder, Ops agents are in the gated group.\
They are independently scalable. \
These will never take independent actions belong to the Action gate (charge money, live publish, social media) \
\
Orchestrator: \
Accepts the initial prompt\
Generates to brand doc\
Creates work for the Marketer, Web Builder, and Ops \
Does not initiate deployment, video generation, or customer payment actions\
\
Top intelligence tier: OpenAI Sol 5.6\
- the brand doc guidance will contain the key intelligent and GTM approach - need max intelligence  \
\
\
MArketer: \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Receives the brand document from Orchestrator\
Does not initiate deployment, or customer payment actions\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Mid Intelligence tier: OpenAI Terra 5.6\
- This will generate 
\f1\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 landing copy + 3-5 social posts + a\'a0
\f3 \cf2 \cb3 \strokec2 launch email
\f1 \cf2 \cb3 \strokec2 \'a0+ a launch video\'a0
\f3 \cf2 \cb3 \strokec2 with a vertical social cut
\f1 \cf2 \cb3 \strokec2  via Veo. 
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 \
\
Web Builder:\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Generates HTML / CSS for marketing website\
Sends to Action Gate for Cloudflare deployment\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Initiates deployment via the Action Gate\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 High Intelligence tier: OpenAI Sol 5.6\
- Need good code generation and ability to consume the brand doc and incorporate its guidance and avoid ai slop. Since Design is highly important to earn customers, this is <$1 spend for something customers will see. \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
Avoiding AI slop in Design\
\
- LLM call (independent) which takes the brand document and the rendered HTML and checks it.\
 - response is either approved, or specific feedback\
- Cap at 3 revision rounds\
- judges rendering on mobile and web, not the source code\
- uses Terra 5.6 \
\
- Good Taste: Based on my web research, the low hanging fruit to avoid AI slop is to have a detailed prompt that outlines a design that you want - dont say \'93create a local rental business site\'94, you need to say \'93Create a high converting landing page for a local rental business targeted towards X\'94 There should be a headline, one sentence under the headline, and easy way to build customer trust, answer the customers questions and allow them to contact us. The FAQ should be an accordion. Most customers will be on mobile, the visual theme should be light. The design should be for a local business, not a corporate one\'94 Combined with the brand document.  Reference: https://superdesign.dev/blog/ui-design-prompts \
The idea will be to parameterize this prompt template.\
\
Ops \
Inserts into DB the initial catalog\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 Does not initiate deployment, video generation, , or customer payment actions\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
Ops lower intelligence tier: OpenAI Luna 5.6\
- this is doing directed business actions and does not need to independently reason\
- check for Avoiding AI slop for marketing accuracy\
\
Avoiding AI Slop in accuracy\
\
Non-LLM checks\
- cross check pricing on HTML vs database catalog\
- regex for lorem ipsum, TODO\
- check contact details match customer details \
- validate hyperlinks , valid HTML, images are valid, viewport meta is present, URLs return 200 status\
\
\
Pricing for short context as of August 8, 2026\
gpt-5.6-sol $5.00 per 1M input tokens / $30.00 for 1M output tokens\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 gpt-5.6-terra $2.00 per 1M input tokens / $12.00 for 1M output tokens\
gpt-5.6-luna $0.20 per 1M input tokens / $1.20 for 1M output tokens\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
\
Database Schema \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
Table: tasks (for admin dashboard)\
\pard\pardeftab720\partightenfactor0

\f1\fs28 \cf5 \cb6 \expnd0\expndtw0\kerning0
id, tenant_id, run_id, task_type, status, output_ref, updated_at, with a unique\'a0key\'a0on\'a0(tenant_id,\'a0task_type).
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
Table: Customer  (note: this is a customer of the business) \
id, tenant_id, name, email\
\
Table: Tenants (note: this is a customer of Epyhia)\
Id, name, email\
\
Table: marketing_posts\
Id, tenant_id, medium (email, Facebook), contents, status\
\
\pard\pardeftab720\partightenfactor0

\f2\fs26 \cf2 \cb4 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 Table: reservations
\f1\fs28 \cb3 \'a0(id, tenant_id, customer_id, start_date, end_date, status, total, stripe_checkout_session_id, created_at)\
\pard\pardeftab720\partightenfactor0

\f2\fs26 \cf5 \cb7 \outl0\strokewidth0 Table: \cf2 \cb4 \outl0\strokewidth0 \strokec2 reservation_items
\f1\fs28 \cb3 \'a0(id, reservation_id, rental_item_id, qty, day_rate)
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 \

\f2\fs26 \cf5 \cb7 \expnd0\expndtw0\kerning0
Table: 
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 rental_items(id, tenant_id, name, description, available_qty, day_Rate)\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0
\cf0 \
Note that the actions log is the audit table\
\
Brand Document\
\
Contains:\
Business Story: Background, Mission, Strengths, Target Demographic\
Logo and logo usage guidance\
Typography Rules\
Writing Tone and Grammar Guidance \
Color PAlletes\
Imagery Guidance: Dos and Donts\
Layout Template guidance for Social Media \
Contact Details\
\
\pard\pardeftab720\partightenfactor0

\f1\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 What's in it:\
\
where does it live: \
Brand_document_table which is a versioning table of brand documents per tenant. The full_text is stored in the DB table\
Schema: id, tenant_id, version_number, full_text\
\
If the brand document changes (via the Admin Dashboard), a new entry is created and then the sequence of marketing website and social media posts is re-run. \
\
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 IDempotency\
\
Idempotency for business creation (tenant onboarding) is described in onboarding with the task list.\
If the same brief is submitted twice (by the same user) then the 2nd brief would be rejected and the task dashboard from the original submission is brought up. The rejection appears as a status bar on the Admin Dashboard (user presses X to dismiss) If there are failed tasks, those should be resubmittable. \
\
Deployment Idempotency: 
\f1\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 one Cloudflare project per tenant; re-deploy overwrites, never creates a second site.
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0  \
\
Stripe idempotency: 
\f1\fs28 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 derived from the reservation id; webhook handler dedupes by Stripe event id (Stripe retries webhooks)
\f0\fs24 \cf0 \cb1 \kerning1\expnd0\expndtw0 \outl0\strokewidth0 \
\
\
Failure Catalog\
\
1. Tenant customer paid for business creation but didn\'92t get a deployed website: On a failed deploy, a check should occur that deployed URLs are returning 200. Failure to deploy should attempt 1 retry, otherwise send an alert to the epyhia Administrator. The Administrator will receive a message saying the failure has been logged and being investigated. \
2. Tenant customer receives marketing copy which does not match their wishes. Off-brand, False or inaccurate Claims on marketing: incorporate human reviews for marketing copy\
3. Business customer gets double charged. Duplicate charges on crash or retry - see Stripe idempotency\
4. Epyhia Business cannot control costs. Irreversible actions - publish, go-live, and video generation go through human review via the gate. Customer initiated charges are already human approved (initiated by human customer)\
5. Tenant Customer gets false information put on their marketing copy.  Fabricated social proof - incorporate into the marketing prompt to be honest and not include reviews/testimonials \
6. Business Customer receives inaccurate reservation confirmation information. Business logic - double booking avoidable. Business logic checks for quantity available before booking using SELECT for UPDATE Also needs to check date overlaps. .\
7. Inaccurate descriptions on website vs DB Schema. After website is generated, conduct a programmatic check of the website vs business catalog descriptions and prices\
\
\
\
\
\
\
}