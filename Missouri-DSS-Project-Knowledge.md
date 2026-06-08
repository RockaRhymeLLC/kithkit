# Missouri DSS — Project Knowledge Base

> **Client**: Missouri Department of Social Services (DSS)  
> **Primary Division**: Family Support Division (FSD)  
> **Servos Account Team**: Will Loving, Pat Snow, Ashley Haglin, David (WWT partner)  
> **Last Updated**: April 2, 2026  
> **Sources**: Servos OneNote (Servos Clients notebook → State of Missouri section)

---

## Table of Contents

1. [Account Overview](#account-overview)
2. [Key Stakeholders & Contacts](#key-stakeholders--contacts)
3. [DSS Organizational Structure](#dss-organizational-structure)
4. [Current Engagements & Opportunities](#current-engagements--opportunities)
5. [Systems Landscape](#systems-landscape)
6. [State IT Standards & Enterprise Platforms](#state-it-standards--enterprise-platforms)
7. [Competitive Landscape](#competitive-landscape)
8. [Procurement & Contract Vehicles](#procurement--contract-vehicles)
9. [Meeting History & Key Decisions](#meeting-history--key-decisions)
10. [Other Missouri Opportunities](#other-missouri-opportunities)

---

## Account Overview

Missouri DSS is a multi-year, multi-division opportunity centered on modernizing citizen-facing portals and back-office systems across the Department of Social Services. The account started with conversations around Child Support and Income Maintenance (Medicaid/SNAP) in 2022 and has expanded into grants management (DESE), professional licensing, and a statewide citizen portal initiative.

**Core value proposition**: Servos delivers ServiceNow-based citizen portals, eligibility workflows, and system integrations. Missouri has standardized on ServiceNow as an enterprise platform, giving Servos a strong position.

**Strategic context**: There is a major statewide initiative for a "Citizen One Stop" portal — a single front door for all state services. This is being driven by the Office of Administration (OA) and is the largest potential opportunity in the account.

---

## Key Stakeholders & Contacts

### State Leadership
| Name | Title | Notes |
|------|-------|-------|
| Ken Zellers | Commissioner/COO of the State | Reports to Governor. Former Anheuser-Busch exec. Met during Jeff City visit with WWT. Effectively runs state operations. |
| Paula Peters | Director, Digital Modernization Division | Former Deputy CIO. Now leads statewide Citizen Portal and ERP replacement. Knows Servos through Pat Snow at NASCIO. Key relationship. |
| Jeff Wann | CIO | Cost-conscious. Paula Peters is the real operator. |
| John Laurent | Deputy CIO → Dir of Enterprise Apps | Former Accenture. Respected. Stephanie Brooks took his old position. |
| Stephanie Brooks | Head of Enterprise Apps | Connected with Jeff Clines. Met for breakfast during April 2023 Jeff City trip. |

### DSS / Family Support Division (FSD)
| Name | Title | Notes |
|------|-------|-------|
| Kim Evans | Director, FSD | Leads both Income Maintenance (Medicaid) and Child Support. Key champion for common portal across all DSS. Interested in Tennessee model. |
| Liane Vanderveld | Kim Evans' Assistant | Liane.Vanderveld@dss.mo.gov |
| John Ginwright | Deputy Director, FSD Child Support & Enforcement | Oversees Child Support area. |
| Angela Terry | Child Support Systems Unit | Technical contact for CS systems. |
| Valerie Taylor | Region 2 Field Operations | |
| Director Nodell | DSS Secretary/Director | Supports common portal vision. |

### IT / ITSD
| Name | Title | Notes |
|------|-------|-------|
| Jeff Cassmeyer | IT Apps Manager, ITSD DSS Liaison | Sees value in connections between Income Maintenance and Child Support. CS systems being refactored over 2-3 years. |
| Erin Lepper | Business Relationship Manager, DSS | Key connector. Suggested connecting with Angela Anderson (DESE BRM). |
| Sarah Kent | DSS ITSD Lead | |
| Renee Wright | ITSD | Leads Citizen Portal project. Pushing SHI for procurement. |
| Dan H | Enterprise Architect | Met during April 2023 trip. |

### DESE (Dept of Elementary & Secondary Education)
| Name | Title | Notes |
|------|-------|-------|
| Stuart Koelling | DESE Grants lead | Arranged demo. Detailed knowledge of grants functionality needs. |
| Margie Van Deven | DESE Director | |
| Pam Thomas | New Dir for Office of Childcare | |
| Teresa Kelly | DESE key contact | |
| Dee Goss | DESE Grants team | Met during April 2023 trip. |

### Procurement
| Name | Title | Notes |
|------|-------|-------|
| Angela Sutton | Procurement | |
| Tara | Finance/Procurement | |

### Partner Contacts (WWT)
| Name | Title | Notes |
|------|-------|-------|
| Ian Hilton | WWT SLED AE (Missouri) | Main WWT contact. Can set up meetings. |
| Michael Gallagher | WWT | Former head of St Louis Accenture office. Deep MO relationships in OA IT. |
| LaDonna Boyer | WWT SLED Services Lead | Based in St Louis. |
| Phil Palmer | WWT ServiceNow Practice Lead | Reactionary. Did $21M SN services in 2021. Only 4-5 people. |
| Latoi Works | WWT Global Partner Coordinator | Latoi.Works@wwt.com — 314.919.1445 |

---

## DSS Organizational Structure

```
Missouri Office of Administration (OA)
  └── Commissioner/COO: Ken Zellers
      └── CIO: Jeff Wann
          └── Deputy CIO / Digital Modernization: Paula Peters
              ├── Enterprise Apps: Stephanie Brooks (formerly John Laurent)
              └── ITSD teams supporting each agency

Department of Social Services (DSS)
  ├── Family Support Division (FSD) — Dir: Kim Evans
  │   ├── Income Maintenance (Medicaid/SNAP)
  │   │   ├── MAGI system (expanded Medicaid)
  │   │   ├── FAMUS system (legacy)
  │   │   └── 57,000 renewals/month
  │   ├── Child Support & Enforcement — Deputy Dir: John Ginwright
  │   │   └── 550 state staff (everyone answers phones)
  │   ├── Rehabilitation Services (Service for the Blind)
  │   └── Work Programs / Workforce Development (smaller)
  ├── DESE (Education)
  │   └── Grants Management (ePeGS system)
  └── Other Divisions (DNR, Professional Licensing, etc.)
```

---

## Current Engagements & Opportunities

### 1. DSS Citizen Portal (Highest Priority)

**Status**: Active pursuit — statewide initiative  
**Scope**: "Citizen One Stop" — single portal across all DSS divisions  
**Champion**: Kim Evans (FSD), Director Nodell (DSS), Paula Peters (OA)

**Background**: Multiple meetings since 2022. Kim Evans originally discussed an FSD-only portal but the vision has expanded to a common portal across all of DSS. The initiative ties into a larger statewide "One Stop" vision (similar to Tennessee's One DHS).

**Key requirements**:
- Self-service portal for citizens (forms, status checks, payments)
- Integration between Income Maintenance and Child Support (currently zero integration — e.g., address changes don't flow between systems)
- Automated eligibility renewals (Medicaid)
- Text/email communication to citizens
- Single sign-on across divisions
- AI-powered phone support (FSD has 550 staff answering phones constantly with basic information)

**Phases discussed**:
- Phase 1: MAGI (Medicaid), EVS, FAMUS, ECM, SSO
- Phase 2: EBT (FIS vendor), Child Support integration, Phone system, Task Management through AI

### 2. Medicaid Annual Renewals

**Status**: Discussed in detail (5/12/2022 meeting)  
**Volume**: 57,000 renewals per month  
**Systems**: MAGI (METUS), FAMUS (legacy), ECM  

**Workflow**:
1. Pull renewals 55 days in advance
2. Electronic verification first (MAGI system)
3. Pre-populated forms for citizens to review, approve, sign
4. Communication blasts: mid-month reminders + 10-15 day final push
5. Returned mail handling per CMS requirements

**Key needs**: Portal for citizens to upload documents, view renewal status, submit online. Currently have basic document upload portal only. Need text messaging capability.

### 3. Child Support Portal

**Status**: Active — Conduent awarded integration work  
**Systems**: Legacy IBM system (Conduent, implemented 1998)  
**Funding**: ARPA funds allocated for Deloitte to refactor code (16-18 months)

**Key details**:
- Current/Change Innovations launching new tasking system
- Need citizen-facing portal for: viewing payments, enforcement measures, upcoming court hearings, report filing
- Conduent told to go through Insight on NASPO ValuePoint contract (Servos could go through Carahsoft)
- Deloitte may be bidding on building a MyDSS portal — status unclear

### 4. DESE Grants Management

**Status**: Demos completed, ongoing discussions  
**Current system**: ePeGS  
**Key functionality needed**:
- Schoolwide Pool (LEAs pool multiple funds)
- Tiered Monitoring (desk monitoring + on-site visits + corrective action plans)
- Compliance Plans (per-grant metrics tracking)
- Funding Source tracking (state vs federal)
- Budget and Invoicing (complex — currently in Salesforce for Montana)
- Custom vs Configuration guidance

### 5. Professional Licensing

**Status**: Demo completed (June 2023)  
**Scope**: 12-15 licensing boards, 14 unique processes  
**URL**: https://pr.mo.gov/professions.asp  
**Key contact**: Michael Trapani  

**Needs**: Single portal for multiple license types, ability to apply for multiple licenses, renewal reminders, unified view of all applications.

### 6. SD DOE / DESE Ed Cert Issue

**Status**: Remediation/damage control  
**Context**: South Dakota DOE Ed Cert project had bad feedback. Project was larger than expected (included PRF + Teacher411 portal). Key challenges: data quality/migration issues, limited SD DOE team availability, too many assumptions by Servos team.

---

## Systems Landscape

| System | Division | Purpose | Notes |
|--------|----------|---------|-------|
| MAGI / MEDES | FSD Income Maintenance | Medicaid eligibility (expanded) | On METUS platform |
| FAMUS | FSD Income Maintenance | Legacy Medicaid (non-MAGI adults) | Older system |
| FACES | FSD | Adult services | |
| EBT | FSD | Benefits distribution | FIS is vendor |
| ECM | Multiple | Electronic Content Management | Phase 1 integration target |
| Child Support System | FSD Child Support | Legacy IBM (1998) | Conduent-maintained. Deloitte refactoring with ARPA funds |
| Current/Change Innovations | FSD Child Support | New tasking system | Launched first week of June (2022) |
| ePeGS | DESE | Grants management | Legacy — replacement candidate |
| Genesys | Multiple | Live chat / phone | Alan Jackson soft-launched live chat. Appointment scheduler delayed |
| HyperScience | DSS | AI handwriting recognition | Recently adopted — SN Doc Intelligence could compete |
| SharePoint + FileNet | DSS | Content/document management | On DB2 database with Tableau reporting |
| MyDSS Portal | DSS | Current citizen portal | Uses DCN, SSN, or Birthdate for ID. Basic document upload. |

---

## State IT Standards & Enterprise Platforms

Missouri OA IT has standardized on:

| Platform | Purpose | Status |
|----------|---------|--------|
| **ServiceNow** | Enterprise workflow & citizen portals | ✅ Active — Servos' primary platform |
| **Mulesoft** | Integration platform (statewide) | Selected, not yet implemented |
| **OKTA** | SSO / Authentication | In process, internal-first rollout |
| **OnBase** | Document Management | Active |
| **K2 Intex** | RPA (Robotic Process Automation) | Active |
| **Adobe Experience Manager** | eSignature | Active |
| **AWS** | Data Lakes | Active |
| **Oracle Cloud** | ERP (replacing legacy) | $100M project, Accenture implementing |

---

## Competitive Landscape

| Competitor | Presence | Notes |
|------------|----------|-------|
| **Deloitte** | Strong | On MO state services contracts. Refactoring Child Support system with ARPA funds. May be bidding on MyDSS portal. |
| **Accenture** | Strong | Implementing $100M Oracle Cloud ERP. Built medicinal marijuana system. Michael Gallagher (WWT) used to run their STL office. |
| **Conduent** | Child Support | Maintains legacy CS system since 1998. Awarded portal integration work. |
| **TCS** | Labor/Youth Services | Implemented UI Interact. Talking about modernizing unemployment insurance. In Youth Services/Child Welfare. |
| **SHI** | Procurement partner | Renee Wright pushing SHI. Could be procurement vehicle. |
| **WWT** | Partner | Strong OA IT relationships. Want to partner with Servos. On state contracts alongside Deloitte/Accenture. Will mark up rates 20-30%. |

---

## Procurement & Contract Vehicles

- **NASPO ValuePoint** (via Carahsoft): Servos' preferred vehicle. MO procurement claims they can't use it for services alone (must include licensing) — unclear if this is accurate.
- **SHI**: Renee Wright pushing this route. Alternative vehicle.
- **WWT contracts**: On specific MO state contracts for services.
- **Sole source**: Procurement recommended sole source for portal PAQ (as of 12/27/2022 call with Renee Wright).
- **Statewide One Stop Portal**: Will likely be an RFQ/Quote request (NOT an RFP). Will need to partner (WWT likely) to compete against Accenture and Deloitte.

---

## Meeting History & Key Decisions

### November 2022 — Jefferson City Visit (Ashley/Jenni/Will)
- Met Ken Zellers (Commissioner/COO) at Capitol — WWT introduced Servos as go-to SN partner
- Met Paula Peters — knows Servos from NASCIO via Pat Snow
- Met Erin Lepper (DSS BRM) — suggested connecting with DESE BRM
- Identified multiple opportunities: DMV modernization, Public Safety, professional licensing, 311 Portal, marijuana regulation
- Learned about statewide One Stop initiative
- Discovered HyperScience AI tool adoption — potential SN Doc Intelligence opportunity

### December 2022 — MO Statewide Portal PAQ
- Call with Renee Wright
- Procurement recommending sole source to Servos
- SHI being pushed as vehicle

### May 2022 — DSS FSD Meetings
- 5/5 call with Kim Evans: Child Support portal discussed, systems integration needs, statewide One Stop vision
- 5/12 Medicaid renewals meeting: Detailed renewal workflow, 57K/month volume, Phase 1/2 planning
- 5/18 demo by Jacob Searls

### June 2023 — Professional Licensing Demo
- Demo for MO professional licensing
- 12-15 boards, 14 unique processes
- Portal + workflow + renewal management

### April 2023 — Jefferson City Trip
- Flight from Richmond → Carroll County MD → Spirit of St Louis → KJEF
- Monday: DESE Grants meeting with Dee Goss; John Laurent meeting
- Tuesday: Breakfast with Stephanie Brooks; SN enablement meeting (9am-1pm); Dan H Enterprise Architect meeting (1:30pm)

### September 2023 — SD DOE Ed Cert Issue
- Damage control for South Dakota DOE feedback
- Key lessons: avoid assumptions, ensure dedicated client team, data quality assessment upfront

---

## Other Missouri Opportunities

| Opportunity | Agency | Notes |
|-------------|--------|-------|
| DMV Modernization | DMV | FAST vs Salesforce consideration. SN opportunity if SF doesn't win. |
| Public Safety / Disaster Recovery | DPS | Sandy Carson is lead. Not under OA IT control. Leverage FL DR story. |
| Marijuana Regulation (Recreational) | DHSS | Accenture built medicinal system. Recreational now legal. |
| 311 Portal | City of St Louis | CTO Simon Huang. $1B ARPA + NFL lawsuit money. |
| Fleet & Asset Management | OA | Can be big in MO. |
| Secretary of State | SOS | Library, Elections, Grants Management — via WWT/Stacy |
| Labor & Regulation (UI Modernization) | DOL | TCS incumbent. Division of Economic Security has new director. |
| DHSS (Health & Senior Services) | DHSS | Paula Nicholson (director), Lydall Franker (director) |
| Facilities Management | OA | New facilities head reports to Ken Zellers — Asset Mgmt + FSM opportunity |

---

## How to Use This Document

This knowledge base is designed to:
1. **Onboard new team members** — Read sections 1-6 for account context
2. **Prepare for meetings** — Check Key Stakeholders and Meeting History
3. **Identify opportunities** — Review Current Engagements and Other Opportunities
4. **Understand competitive positioning** — See Competitive Landscape and Procurement sections
5. **Update continuously** — Add new meeting notes, contact changes, and opportunity updates as they happen

*Generated by marvbot from Servos OneNote — State of Missouri section (10 pages)*
