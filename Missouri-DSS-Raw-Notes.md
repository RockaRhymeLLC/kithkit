# DSS - HR1
(Last modified: 2026-03-16T20:04:59Z)

DSS - HR1







DSS "Constituent Engagement Portal" RFP:


- Mention CEO / Executive level involvement in project and success

- Highlight the AZHCCCS work we are doing with EY to show experience







Carole Hussey Resources:


Here are some of the resources that I would have available to support the Missouri work:


- (15) Emily Eelman | LinkedIn - Based in Denver. Policy expert.   

- (15) Sheila Cooper | LinkedIn - Based in Austin. Tech consultant.

- (16) Missy T. | LinkedIn - Based in Knoxville. Policy/tech bridge.

- Amy Ferraro Whitsett | LinkedIn - Based in Boston. Fiscal policy expert.



I'll continue to think about Curam resources. I'm sure I can come up with someone. 













Summarized meeting notes from on-site with Toi and team in Vegas on 3/10




Meeting Notes


Overview Client is pursuing a standalone grants management application. SNAP, TANF, and Medicaid currently have no dedicated teams — caseworkers are integrated across programs.


Goal: New DSS Portal Client wants their own DSS instance rather than starting on the ITSD instance, citing the inability to scale and move quickly on a shared platform. The current FSD Benefits Portal will be decommissioned and replaced, with SNAP, TANF, and FAMIS migrating to the new portal.


Medicaid MEDES is the eligibility system handling MAGI/ACA marketplace requirements and runs on Curam. The goal is one new, modern Medicaid portal with a Google AI chatbot living across relevant areas, plus one citizen-facing chatbot overall.


Citizen Identity & Intake Integration with ID.me for the citizen experience. The vision is a common intake questionnaire that identifies what benefits a citizen needs and routes them accordingly (e.g., if SNAP-eligible, route to the easier benefits access path - they have and get a lot more funding for SNAP).


Income Verification Income verification and work requirements will be handled via Steady IQ (supporting 1099/gig work with W-2s and income passport coming). A data orchestration layer will check Equifax first — if Equifax satisfies enough requirements, the system auto-approves; if not, it escalates to paid sources like Steady IQ to verify remaining requirements.


Caseworker Case Management Second major workstream is caseworker case management — not replacing existing systems but augmenting them. Caseworkers currently juggle 3 screens and 10-15 applications with manual calculations. Two specific systems caseworkers dislike most are the current tasking system and the Insights Engine — the goal is to replace both with a mix of Steady IQ and ServiceNow.


An AI control tower will provide reporting capabilities including Gemini. This is intended to increase caseworker capacity.


Timeline & Next Steps


- 30-day discovery: redesign workflows while determining technical requirements

- Expect frequent in-person engagement during that, open to virtual after that until they get to UAT

- Target: December 31st deadline



Key Requirements from Servos


- Experience with Curam and API development with MEDES — identified as a critical application (Redmane is currently handling Curam changes and needs a capable partner)

- IVR work currently in progress

- ServiceNow orchestrates backfills to MEDES and FAMIS

- 
Steady IQ for verification (income verification, work/education/volunteer requirements)


- Volunteer will be lowest priority, self reported less than 2% of people use this




- Automated IVR front end

- Healthy Together mobile app referenced as part of the ecosystem



Skill Evaluation Needed Client wants to understand where Servos can scale and is looking for examples of prior similar work. Curam/MEDES API experience flagged as critical.

---

# CECE Project Strategy
(Last modified: 2026-04-02T12:55:22Z)

CECE Project Strategy








Carole Hussey - Evolv Strategy Resources - Senior SMEs

- Uma Ahluwalia - Based in Northern VA. Here is her bio. Rate is $225

- Michele Prior - Based in MA. Rate is $200

- Sheila Cooper - Based in Austin, TX. Rate is $275 - Tech consultant.-(15) Sheila Cooper | LinkedIn 

- Eric Nicklaus - Based in NY. Rate is $225

- Missy Taylor - Based in Knoxville, TN - $225/hr - Policy/tech bridge. - (16) Missy T. | LinkedIn

- Dev (Devananda) Muthakana - Miami FL - Curam - https://www.linkedin.com/in/devmuthakana/

- (15) Emily Eelman | LinkedIn - Based in Denver. Policy expert.   

- Amy Ferraro Whitsett | LinkedIn - Based in Boston. Fiscal policy expert.

---

# Missouri 2026 Plan
(Last modified: 2026-01-28T18:30:09Z)

Missouri 2026 Plan









- Is this intended as a full platform replacement for what they currently use, or is it specific to this use case?  The use case is for Medicaid/SNAP/TANF all connected to HR1 requirements.  The plan is to replace the current login process and LN may be connected at a later point for residency verification.

- Is central IT involved in these discussions?  Central IT is aware and talked with John L this morning with the understanding that no resources would be needed from ITSD (meaning the tech team on this would be Servos)

- Will this require a new instance, or will it leverage an existing one? They don't have an ironed out plan for a new instance or use the existing but my recommendation was to use a new instance.

- Will this replace Okta or integrate with it?  There is no OKTA integration planned and it would happen down the road if necessary.









- ServiceNow strategy - Andy Martin is stepping in for Paul K which is a big risk since he isn't very good. Will need to manage around him, but not let him screw things up.

- 
Winton


- Set call up for next week to sync and talk strategy - bring up procurement bottlenecks and bad trends with inexperienced partners getting SN work

- Combat the Accenture wave of BS




- 
DSS


- Plan trip to Jeff City before 2/28 to make the rounds with Toi and others - goal to address the scale concerns and keep building the relationship

- Leverage Logan and Liz relationships to ride on

- ID.me project with Logan - timing?

- Consider KPMG or EY possibly (not desired) as partner to address Toi concerns and here desire for an "SI" given project complexity




- 
DNR


- Re-connect with Collette - try to meet in Jeff City on trip




- 
ITSD


- Re-connect with Renee, Stephanie, John Laurent and others during Jeff City trip




- 
AI Strategy


- Set meeting with Tim M and send some pre-read info on our AI companions and Tavus solutions - pitch a demo




- Other agencies in Missouri we should be pushing? - Corrections - leverage Don Page SME

---

# Feb2026 Jeff City trip
(Last modified: 2026-02-01T16:25:24Z)

Feb2026 Jeff City trip







Dates: Wed-Thurs/2/10-11


Priority meetings to setup:


- Toi Wilde, Jess - sent e-mail/text

- DNR - Collette and others

- ITSD - Laurent, Stephanie and Renee -emails sent

- AI - Tim M - sent email

- Winton - sent email

- Corrections

- DESE - Angie?, Barb

- Medicaid - ?

- DHEWD - grants?

- DOLIR - PMO guy

---

# DSS FSD Program Modernization
(Last modified: 2025-08-30T02:18:51Z)

DSS FSD Program Modernization







08/29/2025


Call with Paul Kilgore after we received the stand down from Wes on the Ride-along




- 
Paul had a conversation with Toi:


- Toi is learning she needs to follow the rules and not jeopardize our ability to bid on the QVL SOWs for this project

- The Ride-alongs may just wait for the project to start vs. doing now with just SN

- Toi is working with Google (Ian the WWT guy is now the sales guy at Google) - they are doing some sort of IVR implementation of Google's tool and it's already reduced call center traffic down

- Procurement will likely take 60 days - that is the expectation Toi is setting for the team

- She is still interested in FSM and Legal Services Delivery separately - Paul must be pushing - I reminded him that we can do FSM work








08/26/2025


Call with Will and David Winton - updates on FSD Modernization project




Key Points from David Winton on DSS Strategy/Legislature/Governor:




Importance and Visibility of Project


- This will be a proof project for the MO legislature to invest more money for full scale modernization

- It covers Politics, Policy, etc. and checks the boxes

- HR1 bill is a huge focus from the Governor and legislature

- 
Key focus areas are:


- Limit denials for benefits

- Work requirements are key with HR1 to show all income sources (SNAP-reduce error rates) but also showing work minimums to justify Medicaid eligibility

- Medicaid - more frequent re-authorizations required by HR1 and other Fed requirements

- Ween the state off multiple, expensive, inflexible legacy systems








David's Top 3 Things


- 
Bring online application process truly online


- Fewer touch points

- Better feedback back/forth with the casework and applicant to reduce errors and provide more clear communication

- 
Cvilla work - David and Toi hate to see that work go to waste - was funded by a non-profit (Missouri Org for Better Health-sp?)


- Cvilla work yielded deliverables that David is getting to us from Jessie Dresner - built a better, more straightforward application that could be used as a template for not only Medicaid but other programs

- David wants us to at least review the Cvilla work and leverage it if possible - assumes we need to do the analysis work and break the application into a workflow (playbook?)







- 
Identity Verification - including US Citizenship verification


- David works as a lobbyist for ServiceNow, ID.me and HealthTech

- So he wants IDme to be successful, but claims he doesn't want it to scuttle or slow down this project

- David says IDme has some capability to verify US Citizenship (HR1 requirement) - and the Lexis Nexis does not have this capabilty

- I brought up Socure as an alternative that might be mentioned - he said he thinks Socure can't do this either

- David asked Logan to provide a comparison of Okta/Lexis vs. ID.me with and without Okta

- One of the Biggest stress points for DSS is the Call Center Volume and the majority are around ID verification issues

- They are interested in ID.me because they are not paying by usage which is how Lexis/Nexis charges - still think this is being pushed by Winton due to him being their lobbyist. He claims John Lauren and Toi are interested in ID.me too








HealthTech Info


- Winton revealed the HealthTech is a lobbyist client of his now too

- He said the window to procure services and deploy is short and legislative expectations are quick too and that there won't be a lot of time in the early stages for business process re-engineering

- He's coaching HealthTech to slow down and not try to take over everything.

- Apparently they presented a demo of some kind to Jessie Dressner and confused her - she told him she didn't know what they do or offer…

- Winton is coaching them to focus on their compliance module - they have some solution in that space that is working well in other states

- He also says this project WILL BE on ServiceNow - in fact the appropriations specify ServiceNow so the money can't be spent on another tool





Summary of Winton thoughts on priorities:


- He thinks Medicaid should be the focus - SNAP is secondary (not sure I agree with that - let's let Toi and Jessica make that call)

- 
Medicaid hot buttons are:


- More frequent requirements for Medicaid renewals (every 6 months)

- U.S. Citizenship checks are required now and will need to be done to be in compliance

- Work reporting requirements are more stringent and need to be in the solution




- 
SNAP hot buttons:


- Rules and requirements from FNS to qualify for the funding - compliance

- SNAP enrollment and fulfillment require State employees to be involved - apparently Medicaid does not

- SNAP error rates (I mentioned this is all we're hearing - he said yes, but everyone has that problem)
















--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
















































07/28/25


Attendees: 


- Servos: Will Loving, Lauren Sparks, Megan Mulvihil

- ServiceNow: Paul Kilgore, Doug Bagley, Darris, Shea Laughlin, Alex Althaus | David Winton

- MO DSS : 



Link: https://miro.com/app/board/uXjVJZpNIz8=/ 


Agenda: 


Purpose:


Integrated ServiceNow workflow discussion to focus on enhancements around caseworker and citizen experience and how they will align with the new technology projects.


**In Person Preferred**


9am-12pm:


- Welcome and introductions

- Day in the life of caseworkers

- Technology used

- ServiceNow design Session



12pm-1pm:


- Catered lunch 



1pm-3:30:


- Collaborated deep dive

- Debrief/closeout/action items 





Notes:


- Logistics

- 
Introductions


- 
Goals


- Citizen engagement with the benefits

- **Improve the case workers experience

- The WHY: don't want to process more applications beyond what we have to

- 
Eligibility systems need to be the source of truth – FAMIS + MEDES


- Data governance + auditing







- 
Vendor


- 
Future for HR1 – Income Verification will be a Whole Thing so that will be in the future. In the room for this


- 
Steady IQ


- 
Steady IQ – 1099 team: bring policy and vendors to map out the income verification


- 1099 with steady IQ, with hub use equifax

- There will be a session in the future and one of the goals will be to use income verification - HR1




- Citizen verification up front + sooner

- 






- Equifax

- Experian




- Redmane - MEDES

- Servos - IM Constituent Portal

- HealthTech Solutions – Case Management Improvements

- Healthy Together - SunBucks

- Accenture – Several internal projects + the research project o

- CSG – MEDES PMO Support

- Google – Automated IVR

- ITSD – Other major technical partner




- 
Process Flowing:


- ECM

- Amount of Systems any one case worker needs to interact with. Streamline the tech debt and ensuring supporting workflow







- 
Day in the Life of a Case Worker 


- 
Feedback from the Field – what is the most cumbersome today?


- MEDES Non-MAGI Application

- SNAP – is tedious 







- 
Review the SNAP Applications Swim Lanes


- 
SNAP Reasons to Not Process


- 
Address is not provided or address is incorrect


- How do we update this in the process? To-Do: need a way to make it easier for the citizen to view current information and

- Is this a valid address? Then address verification for the person 




- 
Tier 1 Support: 


- 
Submitted a change report to notify of an address change – that is for multiple benefit programs


- How do I reduce that queue for reviewing the changes

- 
90% of the calls are 


- I reported a change in income

- Change in address or phone number

- Add a newborn to case







- ISSUE for SNAP




- 
If a citizen needs to update : a worker has to approve it or make updates in the system


- Opportunity : when a person submits the change online and it's positioned for a team

- 
FNS has some grey areas and we need to lean into the grey


- If we aren't changing the benefit amount – let's play into some of those things we don't have to verify

- Will need to understand what the simple things are as low fruit




- 
For SNAP MID-Cert Reviews – 12 Y/N questions


- Would be great to do this online and force the fields

- If there's no changes at all, then the system takes the action and the worker doesn’t need to touch




- ONE CITIZEN PORTAL EXPERIENCE







- 
What are things we can do


- 
What are citizens struggling with filling out the form + working with federal partners [SNAP + other applications]


- ACTION: Get more data in the deficiencies with processing the current electronic form







- 
Want to shift to an automatic opt-in for data sharing unless someone opts out


- 
Bax has connections in DC + has been working with FNS to chat through security and privacy 


- Obstructive role guidance where designing a seamless workflow experience to meet the needs with







- 
FNS Requires you to submit updated expenses if you have a change in address – so a simple address change is not just updating the address


- % of time when a change in address has led to a change in benefit? :<what is this data?>




- 
What is Hyperscience actually looking at?


- ACTION: Continuous improvement of hyperscience so that




- 
Task Screen – Registering in Current


- Look at the app, up

- 
What is this task queue? 


- This gets emptied everyday – centralized team that is covering and being responsive

- With current being gone – how do we manage this







- 
Insights Engine – homegrown system integrator


- If frontline would rather have their system flow directly to eligibility system




- Steady IQ

- 
What are the top 3 things to


- Logged into so many systems at one time – simplify the # of systems they are looking at

- Tasking isn't keeping up between systems




- Master Patient Index - conversations with MHD on this

- Medicaid Process Overview




- 
Next Steps


- 
Phase 0


- $0 items – policy, minor website updates and improvements for that low hanging fruit

- 






- 
Phase 1


- 90 days – 1 year

- Will take contracts, dollars, etc




- 
Phase 2 


- 12-24 months




- 
Phase 3


- Greater than 24 months 

- Bigger strategy

- Feasibility and landscaping study and evaluation of the big key systems – result of this study







- 
Debriefing + OCM


- 
Positives (+)


- Having frontline folks here has been unbelievable and value add

- Care about what the front line has to say, and hearing what the frontline has to say

- Collaboration – make customers and front line lives easier

- No one was defensive or got their feelings hurt – no justification or defensiveness

- Comfortable able to speak throughout the session

- Better understanding of the process flow(s)

- Got through all the flows! 

- Real-time identification of low hanging fruit and action items

- Some issues are already being worked on

- Carole + the staff that coordinated this and all the logistics on this session

- Opportunity to share a model with the vendor partners and the shared mental model + engage

- Having all voices represented is powerful




- 
Opportunities (-) [or gaps – what we didn't do]


- 
Didn't really talk about annual renewals - 


- More of an action item from the team to look at that




- Need to be closer to the voice of our customers from a system perspective, be closer to the front line to find those 

- 
Grayness and opportunity to shape process and policy with the priorities shared - can push that narrative forward


- Income verification is a place to push forward




- Stepping back

- 
Vendor Partners – need help with OCM


- State needs to do a better job doing this across programs and across projects




- 
Be more collaborative with creating a future state architecture – consolidate and streamline with the tools you have


- GAP: internally built by ITSD vs vendor built applications

- Architecture tenant + M&O

- There needs to be an even larger umbrella of understanding for the MMIS and how eligibility systems play into that




- Making sure we are focusing on the understanding the big wins to them – focus on the ones that will help them do their job better

- 
Leveraging AI for automation


- Need to get our data and workflows together before truly realizing what AI can do for us




- Contextual awareness of what is in the system NOW

- Internally communicate better – how do we educate each other better so that the field team can be the OCM and cheerleaders in the field?

- Lack of trust in the data – integrity of the data and the process will be paramount to success

- Challenges – forced change with HR1



















Opportunities


- 
Solutioning for Change Request Backlog


- How to offset for changes to addresses, phone numbers, children, income




- 
Online Application Versioning + Sync with the Portal


- Improving application usability, required/mandatory fields

- Help text and common language – guiding through the application




- 
Verification Process Up Front


- Citizen Verification + tying to a DCN

- Income Verification




- Managing Consent at the Citizen Level vs. Pushing that Burden to the Workers

- Work through updating FAMIS + MEDES screens to reduce confusion for case workers

- ServiceNow + ECM workflow [FileNet Today]

- Determining what data needs to be sent at what interval

- Managing duplicate data (DCNs)

- Workflow tool to also account for staffing projections and staffing plans

---

# MO FSD Roadmap
(Last modified: 2025-08-22T21:50:46Z)

MO FSD Roadmap









Great — I’ve reviewed all the uploaded workshop outputs (meeting minutes, process maps, swimlanes, and system diagrams). Here’s a structured synthesis of the Missouri DSS Family Services Division (FSD) priorities, and how the Servos team can create a high-level roadmap using ServiceNow’s Public Sector Digital Services (PSDS) capabilities to deliver both quick wins and strategic platform consolidation.








1. Key Themes & Priorities from the Workshop






Citizen & Caseworker Experience




- Citizen-facing improvements: More intuitive portals, seamless omni-channel engagement (portal, IVR, mail, fax), digital signatures, and proactive notifications (SMS, email) .

- Caseworker efficiency: Reduce the number of systems required for daily tasks (FAMIS, MEDES, Current, Encapture, FileNet), automate routine changes (like address updates), and eliminate rekeying of data .







Process Pain Points




- SNAP applications: Backlogs due to incomplete applications and address change workflows. Predictive dialer and mid-certification automation are underused opportunities .

- Medicaid (MAGI & Non-MAGI): Duplicate DCNs, manual paper entry, document upload issues in Encapture, and slow verification turnaround from banks and MRT reviews .

- Document intake: Multiple intake channels (fax, mail, uploads) flow into FileNet, Encapture, and Hyperscience with inconsistent accuracy (⅔ of Hyperscience cases fail). Lack of confirmation messages frustrates citizens .

- Current task scheduler (legacy system): Core bottleneck in task routing and case tracking. Citizens and staff both experience delays.







Strategic Goals




- Reduce technical debt and legacy dependencies (Current, Encapture, redundant data entry into FAMIS/MEDES).

- Enhance ROI by using ServiceNow as an integration hub for case management, workflow orchestration, and citizen engagement.

- Build toward real-time data exchange across systems, reducing delays and duplicate work .









2. Quick Wins with ServiceNow (0–6 months)






A. Citizen Engagement Enhancements




- Document Upload Confirmation & Dashboards: Use ServiceNow PSDS to give citizens real-time confirmation when uploading docs, plus a self-service dashboard to track application status .

- Preferred Contact & Omni-channel Alerts: Implement SMS/email reminders for missing information, recertifications, and interview scheduling (integrated with IVR/Genesys).







B. Caseworker Efficiency




- Address Change Automation: Build a ServiceNow workflow that syncs changes across FAMIS/MEDES and flags expense evidence requirements automatically.

- Error Correction Self-Service: Enable workers to correct simple data entry mistakes without Help Desk escalation (policy pending).

- Task Transparency: Replicate “Day in the Life of a Caseworker” by centralizing work queues in ServiceNow instead of Current.









3. Mid-Term Initiatives (6–18 months)






A. Platform Consolidation




- Replace Current Task Scheduler: Transition case/task routing into ServiceNow Work Assignment. Use PSDS case objects and integration with FileNet/Hyperscience for end-to-end visibility .

- Encapture Integration/Replacement: Use ServiceNow’s document intake APIs to bypass Encapture, reducing indexing errors and redundant uploads .

- Duplicate DCN Management: Build ServiceNow data services layer to detect duplicate citizen records across FAMIS/MEDES, improving identity resolution.







B. Advanced Citizen & Staff Capabilities




- SNAP Mid-Certification Automation: Deploy online mid-certs with Y/N questions, auto-approved when no changes are reported.

- Bank/Asset Verification Automation: Integrate ServiceNow with external HIE and banking APIs to accelerate Non-MAGI eligibility checks .

- Predictive Dialer Optimization: Use ServiceNow workflow rules to trigger outbound call campaigns at citizen-preferred times.









4. Long-Term Transformation (18–36 months)




- Enterprise Workflow Hub: ServiceNow as the central case management platform, phasing out Current, reducing dependence on Encapture, and minimizing manual entry into FAMIS/MEDES.

- AI/ML for Document Processing: Enhance Hyperscience results with ServiceNow AI Ops to validate document classification and auto-route exceptions.

- Policy-Driven Automation: Integrate ServiceNow business rules with federal/state policy updates to automatically guide caseworker decisions (e.g., auto-waive elderly/disabled where policy permits).

- Shared Enterprise Architecture: Build an eligibility hub spanning SNAP, Medicaid, Non-MAGI, and other benefits programs for a single citizen view.









5. Roadmap Summary



Timeline | 
Initiatives | 
Impact | 



0–6 months (Quick Wins) | 
Upload confirmation & dashboards; Omni-channel alerts; Address change automation; Worker error correction; Unified work queues in ServiceNow | 
Improves citizen trust, reduces backlog, immediate worker efficiency | 



6–18 months (Mid-Term) | 
Replace Current scheduler; Encapture integration; Duplicate DCN management; SNAP mid-certs online; Bank/asset verification automation | 
Cuts legacy costs, faster eligibility, better identity management | 



18–36 months (Strategic) | 
Enterprise workflow hub in ServiceNow; AI-enhanced document intake; Policy-driven automation; Integrated eligibility architecture | 
Retires legacy platforms, systemic efficiency, improved ROI | 










6. Recommended Next Steps for Servos




- Validate Quick Wins with FSD leadership — propose a Phase 0 pilot (address changes + document upload confirmation).

- Develop a ServiceNow Integration Plan for FileNet/Hyperscience to demonstrate early replacement of Current task scheduling.

- Engage Policy Teams to align on rules automation (address change expense evidence, error correction permissions).

- Propose an APD Funding Strategy to CMS for federal match on system improvements (upload notifications, duplicate DCN management).

- Design “Day in the Life” Prototype in ServiceNow for SNAP/Medicaid caseworkers to show how workflows will consolidate.







✅ This roadmap gives FSD both short-term wins (citizen satisfaction + staff efficiency) and a clear glidepath toward retiring legacy tools like Current and Encapture while maximizing their existing ServiceNow investment.






Would you like me to convert this into a polished executive-level roadmap deck (PowerPoint format) that you can take back to DSS leadership, or would a detailed implementation playbook (Word/PDF) for your consulting team be more valuable first?




Here’s your implementation playbook for the consulting team:




 Download MO DSS FSD ServiceNow Playbook (DOCX)






You now have:




- Executive Roadmap Deck (PPTX) – for DSS leadership.

- Gamma Prompt – to create an interactive version.

- Implementation Playbook (DOCX) – detailed plan, workstreams, dependencies, RACI, next steps.





Would you like me to also turn the playbook into a condensed 2-page executive briefing (PDF) that DSS leadership can read quickly, alongside the deck? 




Here’s the updated executive briefing PDF with the Gantt-style roadmap included:




 Download Executive Briefing with Gantt (PDF)




This version replaces the earlier simplified roadmap visual with the more detailed Gantt chart so leadership can clearly see initiative timing and dependencies.




Would you like me to also make a version of the Gantt chart as a PowerPoint slide so you can easily drop it into the deck?

---

# DSS FSD July 25 workshop AI notes
(Last modified: 2025-08-22T21:49:18Z)

DSS FSD July 25 workshop AI notes











# 07-28 Meeting Summary: Public Assistance Program Modernization, Workflow Integration, and System Challenges


> Date & Time: 2025-07-28 10:08:35


> Location: [Insert Location]


> Attendees: [Speaker 1] [Speaker 10] [Speaker 3] [Speaker 8] [Speaker 2] [Speaker 21] [Speaker 12] [Speaker 18] [Speaker 13] [Speaker 19] [Speaker 4] [Speaker 15] [Speaker 9] [Speaker 5] [Speaker 16] [Speaker 11] [Speaker 6] [Speaker 17] [Speaker 14] [Speaker 20] [Speaker 7]


## Overview


This comprehensive summary consolidates a series of meetings held with stakeholders from technology vendors, policy leaders, program managers, and frontline staff, focusing on the modernization of workflows and systems for public assistance programs such as SNAP and Medicaid. The discussions, which took place prior to July 28, 2025, addressed challenges in caseworker and citizen workflows, income verification, application processing, address management, system integration, call management, customer communication, and data/reporting strategies. Key themes include the need for streamlined processes, improved system integration, enhanced participant education, and data-driven decision-making. Action items and open issues are grouped at the end for clarity and follow-up.


## Meeting Logistics and Introductions


- Attendees were briefed on room logistics, audio sensitivity, restroom locations, and catering arrangements.


- The meeting was facilitated by designated staff, with support roles clearly assigned.


- Both virtual and in-person participants introduced themselves, representing a wide range of organizations and roles.


## Caseworker and Citizen Workflow Improvements


- Current workflows and technology do not adequately support caseworkers or citizens, leading to inefficiencies and duplication.


- Customization of workflows is needed to better serve both groups.


- Staffing shortages highlight the importance of technology-driven solutions.


- ServiceNow is identified as a key tool for mapping needs and improving workflow efficiency.


- Collaboration among vendors, policy teams, and frontline staff is emphasized to create shared understanding and direction.


## Income Verification and Vendor Integration


- Multiple vendors (SteadyIQ, Equifax, Experian) are involved in income verification.


- SteadyIQ supports 1099 needs; a separate mapping activity is planned.


- Moving income verification earlier in the application process is a goal to reduce duplication.


- Redmane supports the METIS eligibility system, which requires enhancements for dynamic data feeds.


- Servos and Health Tech Solutions focus on constituent portals and case management, with concerns about the proliferation of portals.


## Application Processing and System Integration


- Reviewed flowcharts for Medicaid, SNAP, and other benefit applications.


- Applications can be submitted via paper, electronic forms, mail, fax, or drop-off.


- Manual data entry is required for both paper and electronic submissions.


- The Adobe Experience Manager form provides basic validation but is essentially a digital paper form.


- Need to measure application completion rates and identify reasons for rejection.


- Outdated contact information is a frequent issue.


- System limitations prevent dynamic updating of forms; pre-population for renewals is a desired feature.


- A backlog of approximately 90,000 unprocessed change reports affects multiple programs.


## Change Report Processing and Backlog Reduction


- Most calls are from citizens reporting changes (income, address, etc.), with significant delays in updates.


- Manual processing creates backlogs and requires retroactive adjustments.


- Technical solutions are needed to efficiently clear the backlog.


- Opportunities exist to automate straightforward updates and make mid-certification review questions available online.


- Version control for applications is discussed to support auditability and synchronization across systems.


## Address Management and Consent


- Multiple systems store addresses separately, requiring synchronization.


- Verification is necessary to ensure accuracy.


- A master patient index is under consideration for centralized identification.


- Consent management for data sharing is shifting toward constituent control, with automatic opt-in and opt-out options.


- Policy barriers and federal engagement are ongoing, especially regarding address and income verification requirements.


## Application Intake, Document Management, and Workflow Automation


- Paper applications are scanned and processed through ECM, FileNet, and Hyperscience.


- Online applications follow a similar process.


- Transitioning to Genus for document management and ServiceNow for workflow is planned.


- Lessons from other states, such as Tennessee, inform modernization efforts.


- User experience improvements are needed to reduce confusion between physical and mailing addresses.


## Eligibility Waivers, Task Management, and System Comments


- Confusion exists regarding eligibility waivers and system comments.


- Recent updates to FAMIS aim to clarify these issues.


- Workers manage tasks across multiple systems, leading to inefficiencies.


- Integration with ServiceNow and ECM is seen as an opportunity to streamline workflows.


- Eligibility determination for elderly and disabled waivers is outlined, with automation via Hyperscience.


## Call Management and Participant Engagement


- Balancing inbound and outbound calls is a priority to improve engagement.


- The predictive dialer does not account for participant availability; enhancements are needed.


- Participant education is critical to reduce incomplete applications and improve contact rates.


- One-page overviews and behavioral nudges are suggested.


- Call timing affects success rates; shift adjustments may be necessary.


## Customer Interviews, Data Entry, and Communication


- Predictive dialer and interview processes are outlined, with manual data entry and verification required.


- Staff use multiple systems and screens, leading to workflow challenges.


- Real-time status updates for customers are lacking, causing repeated contacts and confusion.


- Enhancements to the customer portal and IVR are planned.


- Internal communication and policy updates are challenging due to high email volume; regular briefings are suggested.


## Data, Reporting, and Task Management


- Tableau, DB2, and FileNet are used for reporting, but direct connection to the Famous system is lacking.


- Staff must log into multiple systems, complicating workflows.


- Leadership requires accurate data for monitoring and decision-making.


- The Citizen Engagement and Workforce Enhancement Project is introduced to improve workflow and data processes.


## Open Issues & Risks


- No dynamic link between application forms and eligibility systems, leading to outdated information.


- Manual address validation for paper forms may cause errors and delays.


- Proliferation of portals increases complexity for caseworkers.


- Policy changes from FNS regarding version control and address verification are pending.


- Integration and transition between document management systems involve ongoing risks.


- Limited capacity for participant education and unresolved processes for updating contact information.


- Delays from nightly batch processing and lack of real-time customer status updates.


- Trust in automated data flows is low, leading to redundant manual checks.


## Action Items


- [ ] Measure the percentage of SNAP and other benefit applications completed correctly on first submission.


- [ ] Identify and document the most common reasons for incomplete or rejected applications.


- [ ] Explore technical solutions for pre-populating renewal forms with up-to-date information from the eligibility system.


- [ ] Map out the current income verification process and plan for moving it earlier in the application workflow.


- [ ] Review and address the backlog of approximately 90,000 unprocessed change reports.


- [ ] Explore technical solutions for reducing the backlog of change reports.


- [ ] Investigate options for making SNAP mid-certification review questions available online.


- [ ] Gather feedback from frontline staff and citizens on challenges with current paper forms.


- [ ] Initiate policy discussions with FNS regarding version control and electronic updates to applications.


- [ ] Work with Lee or appropriate partners to gather data on deficiencies in electronic PDF forms.


- [ ] Update workflow charts and collaborate with the PMO team to reflect changes in document processing, especially post-Hyperscience integration.


- [ ] Identify and communicate specific policy or security barriers encountered in the past to leadership for federal advocacy.


- [ ] Send examples of confusing interview summary screens to Chris for review.


- [ ] Chris to investigate and clarify the issues reported on the FM1B screen.


- [ ] Continue to report any issues or enhancement opportunities with Hyperscience to the systems team.


- [ ] Explore enhancements to the predictive dialer system to allow participants to specify preferred contact times.


- [ ] Develop and distribute a one-page overview for SNAP applications to educate participants on required information, especially accurate phone numbers.


- [ ] Review and consider adjustments to call shift schedules to better align with participant availability and improve contact rates.


- [ ] Discuss strategies for improving staff communication and policy update dissemination (e.g., regular briefings or huddles).


- [ ] Engage with the FAMIS team to explore API and data feed improvements.


- [ ] Plan major updates to the customer portal to provide real-time status and confirmation for submitted documents.


- [ ] Resume meeting at 11:15 to review Medicaid-related topics before lunch.




> **AI Suggestion**


> AI has identified the following issues that were not concluded in the meeting or lack clear action items; please pay attention:


> 1. There is ongoing confusion and inefficiency due to lack of integration between core systems (such as FAMIS, ECM, Metis, ServiceNow, Fusion, and STPD), resulting in manual data entry, redundant tasks, and errors; it remains unresolved how to automate updates across systems so that task completion in one system is reflected in all others, and there is no clear implementation plan, responsible party, or timeline for resolving this.


> 2. The backlog of approximately 90,000 unprocessed change reports (including address and phone updates) remains unresolved, with no clear technical solution or defined process for efficiently reducing the backlog and preventing future accumulation, posing a significant risk to timely service delivery and data accuracy.


> 3. The process for managing and synchronizing addresses and other key participant data across multiple systems is unresolved, with no master index or definitive source of truth established, leading to ongoing data discrepancies, processing delays, and communication issues with participants.


> 4. It is unclear what specific policy changes or federal approvals (such as from FNS) are required to implement version control, dynamic electronic forms, and simplified address/income verification processes; the process and timeline for engaging with federal partners and securing necessary waivers or adjustments remain undefined, creating a risk of stalled modernization efforts.


> 5. Customers currently lack real-time status updates or confirmation for submitted documents, leading to repeated contacts and increased workload for staff; there is no customer dashboard or confirmation number system in place, and enhancements to the customer portal and automated IVR require further clarification on scope, ownership, and deadlines.

---

# DSS MHD – ITSM + Vendor Management
(Last modified: 2025-07-08T15:58:26Z)

DSS MHD – ITSM + Vendor Management







--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


07/07/25 - Servos | MO HealthNet - ServiceNow Use Case Discussion


Attendees: 


- Servos: Will Loving, Lauren Sparks, Megan Mulvihill, Matt Miller

- ServiceNow: n/a

- 
MO DSS : 


- Hoeller, Michelle - Michelle.L.Hoeller@dss.mo.gov - MO HealthNet Chief Information Officer

- Laura Naught

- Garret Bialczyk

- Sandy

- Michelle Hoeller






Recording: Servos MO HealthNet - ServiceNow Use Case Discussion-20250707_150355-Meeting Recording.mp4


Assets: Servos - MO DSS MO Healthnet Division Use Case Discussion - 07072025.pptx


Agenda: 


- Introductions

- 
Use Case Discussion


- Goals & Objectives

- Pain Points

- Process Clarification




- ServiceNow Capabilities & Platform 'Fit' for Use Cases

- Next Steps



Notes:


- 
Introductions


- Servos: Lauren Sparks, Will Loving, Matt Miller, Megan Mulvihill

- 
DSS


- Michelle – Ticketing, tracking, monitoring + tracking to various vendor 

- Garret – Business systems manager MO HealthNet – day to day operations of the systems and potentially a big part of the userbase

- Laura – Vendor + Process Improvement Specialist – seen SN in the past and excited to see what we have today

- Sandy - 







- 
Use Case Discussion


- 
Combined view into what Garret's team does


- 
Multiple vendor hosted solutions – business systems team – that works closely with out contract for anything as a helpdesk ticket


- MHD population as well as the vendors

- Policy and programmatic staff so the contractors get the dept and detail

- System vendors have independent ticketing systems – goal is to be able to have a central manner for those imported, and use a flow to route them accordingly, and track those – be able to turn those around externally

- Would like to see if there's a way to integrate with those, and have a central manner to track those

- Use Case 1 or 2




- Manner or mechanism to take the contractual SLAs + several ticket SLAs that have contracts with them – see if what we have for ticketing makes sense – outside of the manual manner which depends on spreadsheets

- 
We have release management – we have a very manually driven process for anytime we have a system change. There is a need for a change and a flow or approval process


- A lot of the vendor use this

- Track that we have verified and tested, track all of the release information




- 
What are these vendors?


- 
It can be a combination – have a lot of solution vendors who host these solutions – our partners with ITSD does work on this


- Ie: ITSD has a solution they have developed that our vendors 

- 
Being able to see from other upstream systems and see artifacts finding patterns


- Upstream partner has a problem + reaches out to the state team – need to find a way to track that, identify common problems that may be relevant to that use case that has been reported







- 
For the ticket systems utilizing today – the ones you do have access, are they providing status updates often?


- Yes and no – have one vendor that is more diligent than the other

- Because of the dependency

- So when our systems team members need to reach out to vendor A and vendor B, need the ability to close the loop with those vendor partners







- 
Will: An overarching tracking for all the vendor partners, also need the ability to see 'Sally Jones' submits 105 tickets and they are all critical + flood the vendor's inbox, it closes those things down + need to make it role specific so that it's not just the systems team


- 
Ie: Flow for internal use only and just just with the vendor partners – a ticket gets submitted to a central queue – everything comes into SN, creates a case or an incident – if we determine it's a system issue, it gets escalated as an incident


- Internal or vendor

- 
Reassign to the vendor to work to look at + update (in platform or to theirs via integration), could be via email communication + can email them from SN and when they reply back, it will update the incident as it's provided


- Single point of record to track the SLAs

- We could have one incident with multiple tasks to get their piece of the puzzle as we work that incident to resolution – we have all those capabilities in platform to move all these people and data around













- 
Can better understand how we bring external parties into the mix vs the internal party


- 
Managed care provider vendor system – are the typical problems or issues technical, or is it more policy / business issues...or a typical help desk (system slow, can't reset my password) ...


- Combination of policy driven, technical 

- A lot of research to determine truly if it's technical

- It's more on the lines of did the system respond in the manner we would have expected

- How many systems and vendor contacts are there? Individual systems or ticket







- Goals & Objectives

- Pain Points

- Process Clarification




- ServiceNow Capabilities & Platform 'Fit' for Use Cases

- 
Next Steps


- 
How to assign that work out, work it outside of the system, and get it back


- Doesn't matter how they get the updates – they can speak to it

- 
They may have the same incident going to two separate vendors – this may still be a challenge


- 
Incidents and child incidents + parent/child - one assigned to each vendor


- Won't solve the finger pointing 







- 
There would be some tickets that would be opened and would go to the internal policy folks


- With PSDS in the front-end, that allows you to do internal







- 
Timeline or estimates – they are in the discovery phase and get some things together to get approvals as an official prioritized projects


- Wanted to hear a full start to finish example – said she would send us a more fleshed out example to inform the next demo

- ACTION: Michelle to provide a detailed example use case that can be used to inform a demonstration

- Servos to review, and formulate a demo and get the next meeting scheduled

---

# DSS MHD – Policy & Provider Procurement
(Last modified: 2025-06-18T20:16:03Z)

DSS MHD – Policy & Provider Procurement







--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


06/18/25 - ServiceNow Demo 


Attendees: 


- Servos: Will Loving, Lauren Sparks, Megan Mulvihil

- ServiceNow: Paul Kilgore, Doug Bagley, Darris, Shea Laughlin, Alex Althaus | David Winton

- 
MO DSS : 


- Julie Phillips - Julie.A.Phillips@dss.mo.gov - 

- Kim Johnson - Kimberly.A.Johnson@dss.mo.gov -

- Jennings, Fatima - Fatimah.Jennings@dss.mo.gov -

- Binder, Alexis - Alexis.Binder@dss.mo.gov -

- Kempker, Molly - Molly.Kempker@dss.mo.gov -

- Bialczyk, Garret - Garret.Bialczyk@dss.mo.gov -

- Dresner, Jessica - Jessica.Dresner@dss.mo.gov -

- Daskalakis, Alexander - Alexander.N.Daskalakis@dss.mo.gov -

- Wainscott, Anna - Anna.Wainscott@dss.mo.gov -

- Wilson, Ashley - Ashley.L.Wilson@dss.mo.gov -

- Sooter, Courtney - Courtney.Sooter@dss.mo.gov -

- Martin, Eric - Eric.D.Martin@dss.mo.gov -

- Kremer, Glenda A - Glenda.A.Kremer@dss.mo.gov -

- Purnell, Jamie - Jamie.Purnell@dss.mo.gov -

- Dinwiddie, Kathryn - Kathryn.M.Dinwiddie@dss.mo.gov -

- Webb, Melody A - Melody.A.Webb@dss.mo.gov -

- Hoeller, Michelle - Michelle.L.Hoeller@dss.mo.gov -

- Leigers, Patty - Patty.D.Leigers@dss.mo.gov -

- Sullens, Sarah - Sarah.K.Sullens@dss.mo.gov -

- Johanna Bisges

- Julie Phillips










Recording: OBTAIN


Agenda: Please come in person if you like or join virtually. This time is set aside for Service Now to demo two things for us: (1) they built a platform for FSD for their IM manual and we love it and would like to see if they can do something for us for our provider manuals; (2) they are interested in how Service Now might intersect/interact with our enrollment broker procurement efforts.




Regarding the upcoming meeting with Missouri Medicaid COO, Jessie Dresner, Doug and I have composed a streamlined agenda for the meeting to ensure success. The agenda below better supports the meeting and the focus we want to take on this first call. Please review the agenda below. 




***Will/Servos please provide your input on


- 
ServiceNow Platform Overview (Paul)


- Explanation of the ServiceNow platform and its capabilities.

- Importance of the platform for Medicaid and public assistance programs. 

- Show FSD Manuals (Doug)




- 
Success Stories and Examples (Darris)


- Examples of successful implementations in other states (e.g., Tennessee). 

- Benefits observed, such as reduced call center times and improved communication with applicants. 




- 
Medicaid Discussion (Will/Servos)


- Servos 

- Servos




- 
Next Steps


- Outline the roadmap for the project.

- Assign action items and responsibilities.








Notes:


- RFP for an Enrollment Broker – one day can sign on as a citizen and if I 

- 
ServiceNow Intro


- 


- 



- 


- 



- 





- 
Darris – Success Stories


- 


- 



- 


- 



- 


- 



- 





- 
FSD Policy Manual Capabilities


- 
FSD Policy Manual (Knowledge Base) > 1 INTRODUCTION 
Search (minimum 3 characters) 
a 
1 INTRODUCTION 
> 
1.1 Combined Manual Layout 
1.1 Combined Manual Layout 
1.2 Program Summaries 
1.3 Appendices 
· @ 3mo ago . @ 680 Views Word Count: 164 
@1.4 Numbering, 
ation, and Search 
Introduction 
2 RIGHTS, NOTICES, & DOCUMENTATION 
V 
> 1.1 Combined Manual Layout 
3 MO HEALTHNET (MHN) 
4 TEMPORARY ASSISTANCE (TA) 
5 SNAP 
Copy Permalink 
6 MISSOURI SUNBUCKS - SUMMER EBT 
> 
7 AGED, BLIND & DISABLED CASH PROGRAMS 
> 
8 APPLICATIONS 
9 NON-FINANCIAL ELIGIBILITY 
10 FINANCIAL ELIGIBILITY 
11 VERIFICATION 
V 
12 BENEFIT CALCULATION & ISSUANCE 
V 
gley (Unverified) 
& - + 
An Official Missouri Government Website 
Privacy Policy 
Accessibility 
Contact Us 
2025 State of Missouri. All rights reserved. " width="480" height="278" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-95311c1b11e242448e474f59d8ac8851!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-d6a6f4a22b134311a85cc4813cfdf631!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />


- 



- 


- 



- Knowledge > Medicaid Manuals (Knowledge Base) > Provider - Adult Day Care Waiver Provider Manual 
Search 
0 
> Section 2 
shall indicate the date the reassessment was completed and what provider staff member completed the reassessment. 
. Documentation of the reassessment training must be kept in the personnel file of the individual completing the reassessment. If 
the staff member completing the reassessment is not listed on the DSDS-maintained trainer list, documentation within the 
personnel file must include the name of the individual who provided the training and the date the training occurred. 
Copy Permalink 
Helpful? 
Yes 
No 
Rate this article * 
**** 
Post a comment ... 
Contact Us 
FAC 
Supplier Portal 
Our Policies 
Bagley (Unverified) 
Terms of Use 
Privacy Policy " width="480" height="282" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-b0684ee6411c4777a3aba5b3f16aac9e!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-8dc64792e97d4cceba13e773abecd85b!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />


- 
Is there a way – we have relatively uncomplicated approval process


- We send providers to providers for review prior to publishing

- 
Providers are external – we have an agent in the platform and can ask for review and feedback


- Can drive that through the case assigned to those folks







- 
Provide an enrollment – backend services [Winton]


- 
If all of a sudden there are a certain group – ie neurology – you know you can harness those folks almost as a professional team


- Feed back into the gameable system

- Other thing when pulling this thread 







- 
Low Code / No Code


- FSD Policy Manual (Knowledge Base) 
> 2 RIGHTS, NOTICES, & DOCUMENTATION 
Search (minimum 3 characters) 
a 
1 
1 INTRODUCTION 
2.1 Participant Rights 
1.1 Combined Manual Layout 
1.2 Program Summaries 
1.3 Appendices 
· @ 2mo ago . @ 367 Views Word Count: 2321 
1.4 Numbering, Navigation, and Search 
+ 2.1 Participant Rights 
Legal Authority Rights of Applicants and Recipients -Federal - Medicaid: 42 USC 1396a(a)(3), (4), (7), (8), (43); 42 CFR 431.200-206, 431.210-214, 431.220- 
2 RIGHTS, NOTICES, & DOCUMENTATION 
231, 431.241-246,431.300-306, 435.905, 435.906, 435.911, 435.912, 435.913, 435.919, 435.955; SNAP: Food and Nutrition Act of 2008 as amended, 7 USC 2020; 
7 CFR 272.1, 273.13, 273.14, 273.15 
2.1 Participant Rights 
2.2 Participant Responsibilities 
Non-discrimination - Federal - TA: 45 CFR 260.35; SNAP: 7 USC 2020, 7 CFR 272.6, 7 CFR 273.6; Title VI of the Civil Rights Act of 1964, FNS Instruction 113-1 
2.3 FSD Rights and Responsibilities 
5817 Medicaid Section 1557 of the Patient Protection and Affordable Care Act, 42 U.S.C. 18116 
2.4 Authorized Representatives 
2.5 Confidentiality of Participant Information 
2.6 Disclosures of Participant Information 
+ 2.1.1 Rights of All Participants 
2.7 Safeguarding Information 
"Participant" refers to all applicants and recipients. Participants have rights under State and Federal laws. These rights include the right to 
2.8 Notice Requirements 
2.9 Documentation 
fair treatment, to privacy and confidentiality, to information about the programs and participant's responsibilities, and to appeal certain 
actions and decisions. 
All participants have rights from the time someone asks for an application for assistance through termination of benefits. FSD ensures 
3 MO HEALTHNET (MHN) 
participant rights are respected and enforced. 
V 
Every participant has the right to: 
4 TEMPORARY ASSISTANCE (TA) 
v 
1. Be informed verbally and in writing of their rights, obligations, responsibilities, potential risks, and penalties under these benefit 
5 SNAP 
programs. 
2. Free language assistance services to help participants communicate with FSD. This includes providing participants verbal 
6 MISSOURI SUNBUCKS - SUMMER EBT 
V 
interpretation and written translations in their primary language including sign language and TTY. 
3. Written information in other formats (large print, electronic formats). 
7 AGED, BLIND & DISABLED CASH PROGRAMS 
V 
4. Register to vote through FSD. A participant's decision to register to vote is completely voluntarv. 
gley (Unverified) & - + 
An Official Missouri Government Website 
Privacy Policy 
Accessibility 
Contact Us 
2025 State of Missouri. All rights reserved. 
cript:void[0) " width="480" height="281" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-747f4463c1bb4b09bc4b297500be291d!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-9dee67b182b5442d9a4e9ef7c83264f5!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />


- 
Any trouble with the FSD project getting away from the old way?


- OCM is always a challenge – focusing on the why







- 
Any concern about security when you are pulling data?


- Security is critical and a key component of the platform to have access to the repository of the data.

- Granular permissions based on roles, ACLs, etc. Lock down tightly but granularly

- FedRAMP data center – another level of security

- Office of Cybersecurity works closely with ServiceNow on these items




- 
Educators 


- 
45 Provider Manuals + showed what we did with FSD


- Our 45 Manuals – is there a way to search all the manuals > yes with AI search

- 
Old-school and want to print the manual


- Gives the section for print

- If they want the whole section – would recommend offering an export to PDF of a whole manual







- 
Is there an archive function


- Yes – the platform has archiving and there's versioning




- 
I'm a provider and I go into the manual – can they go back and review archived versions?


- They can't today - 

- 
REQ: want them to be able to click on the 


- Doug: create an archive page that produces a PDF of the prior manual for reference







- 
Do they log in today? No – if you google it'll take you there


- https://mydss.mo.gov/mhd/provider-manuals







- Hate to see manual work or décor

- ACTION: Follow up workshop to continue to discuss needs + requirements for the FSD 




- 
Servos Overview


- What the needs are + gaps

- 
FSD worker – and received an application and the person hasn't created an account?


- Yeah you could do that




- 
Guardrails and cut out the human errors 


- If I am working in MEDES, don't have the guardrails there

- 



- 





- 
One of the Teams – part of what they do daily is fix what doesn't work well now


- All the weird things that happen that get reported to fix things

- In order to do that, need to look into how to fix things

- Is there some value in doing a follow up workshop – potentially, something that pulls together in one place for them to look? 

- Depending on what they are trying to figure out – may be a lot of places to check




- Winton – fair to say the SN platform has access, then it can be configured whatever questions are asking




- 
Enrollment Broker Use Case


- Haven't released the RFP yet – still have a good buffer zone where we feel comfortable talking to folks

- 
If we were trying to do a workshop around that piece, could look at 


- Provider Directory could be interesting

- The whole idea is we are starting to see – whatever systems are running better – if the citizens are getting the same experience than that is 

- Providers right now don't update their information in the







- ADA Compliance is critical for the policy manuals

- 
Follow up and Next Steps:


- Jessie said the Enrollment Broker RFP is still in very early stages so they can still speak with us about it without violating any procurement rules

- Wants to get together in August for a workshop to talk through how SN can be used to support it

- We should sync with Winton and Paul/Doug to see what else they heard in the room

- Send follow up e-mail to everyone on the e-mail list with our deck but add in the rest of the FSD Portal screenshots

---

# MO Healthnet - COO Dresner mtg
(Last modified: 2025-06-10T20:47:53Z)

MO Healthnet - COO Dresner mtg










 

- 
ServiceNow Platform Overview (Paul)


- Explanation of the ServiceNow platform and its capabilities.

- Importance of the platform for Medicaid and public assistance programs. 1




- 
Success Stories and Examples (Darris)


- Examples of successful implementations in other states (e.g., Tennessee, Arizona). 4

- Benefits observed, such as reduced call center times and improved communication with applicants. 5




- 
Medicaid Demo (Shea)


- Revisit of the Jacob's Medicaid demo that was shared with Missouri






 


- 
Future Vision and Goals (All)


- Long-term goals for integrating ServiceNow with Medicaid systems.

- Potential improvements in healthcare outcomes and resource allocation. 6




- 
Q&A Session


- Open floor for questions and clarifications.

- Address any specific concerns or topics raised by participants.




- 
Next Steps


- Outline the roadmap for the project.

- Assign action items and responsibilities.

-

---

# DSS & DHHS & DMH – HCBS Grievance/Critical Incident Process Enhancement
(Last modified: 2025-05-14T15:23:57Z)

DSS & DHHS & DMH – HCBS Grievance/Critical Incident Process Enhancement









--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


05/14/25 - ServiceNow/Servos Demo - HCBS Critical Incident/Grievance Process Enhancement 


Attendees: 


- Servos: Will Loving, Lauren Sparks, Megan Mulvihil

- ServiceNow: Paul Kilgore, Doug Bagley, Alex Althaus, Phil Calzadilla, Shea Laughlin | David Winton

- HSG: Geri Kully, Kelly Harder

- MO DSS : Glenda Kremer, Candy Bohannan, Rena Cox, Richard Ferrari, Michelle Gerstner, Nicole Gatlin, Veronica Jameson, Erica Keller, Jenny Littlejohn, Cory McMahon, Lisa Nothaus, Jessica Schaefer, Clin McMahon, Umo Ironbar-brandt, Kim Stock (kimberly.stock@dmh.mo.gov) [lori hannon]



Recording: OBTAIN


Agenda: *Please forward the invite to anyone you want invited to the demo that is not on the invite list* HCBS Critical Incident/Grievance Process Enhancement Demo with ServiceNow and Servos.


Notes:


Opening Remarks or Comments – Glenda:


- Nothing off the top of my head – Jess or Kim do you have anything?

- 
Intros / Titles:


- Glenda Kremer – Program Manager – DSS-MO HealthNet Division (glenda.a.kremer@dss.mo.gov) 

- Candy Bohannan – APS Business Project Manager – DHSS-Division of Senior and Disability Services (candy.bohannan@health.mo.gov) 

- Rena Cox – DHSS-Division of Senior and Disability Services (rena.cox@health.mo.gov) 

- Richard Ferrari – Manager, Office Director – DSS (richard.ferrari@dss.mo.gov) 

- Michelle Gerstner – Director of Constituent Services – DMH Director's Office (michelle.gerstner@dmh.mo.gov) 

- Nicole Gatlin – DHSS-Division of Senio and Disability Services (nicole.gatlin@health.mo.gov) 

- Veronica Jameson – Unit Supervisor – HCBS - DHSS-Division of Senio and Disability Services (veronica.jameson@health.mo.gov) 

- Erica Keller – Bureau Chief – HCBS System and Data Reporting – HCBS - DHSS-Division of Senio and Disability Services (erica.keller@health.mo.gov) 

- Jenny Littlejohn – OCS Program Specialist – DMH-Director's Office (jenny.littlejohn@dmh.mo.gov) 

- Cory McMahon – Misc. Projects Tech – DMH-Developmental Disabilities (cory.mcmahon@dmh.mo.gov) 

- Lisa Nothaus – Statewide Family Support Coordinator – DMH-Developmental Disabilities (lisa.nothaus@dmh.mo.gov) 

- Jessica Schaefer – DHSS-Division of Senior and Disability Services (jessica.schaefer@health.mo.gov) 

- Umo Ironbar-brandt – DSS-Division of Legal Services (umo.ironbar-brandt@dss.mo.gov) 

- Kim Stock – Director of Quality Enhancement – Developmental Disabilities - DMH (kimberly.stock@dmh.mo.gov) 

- Lori Hannon - 






ServiceNow Demo


- Built OOTB > Is this really? Where + How?

- 
Critical Incidents vs. Grievances + Understanding Why We are Here Today


- 




API/FTP 
Critical 
DHSS DSDS 
Incident 
CI System 
,API/FTP 
Grievance 
DMH DD 
Grievance System 
API/FTP 
DSS MHD 
Aggregator 
Critical 
DMH DD 
Incident 
CI System 
API/FTP 
Encounter 
MMIS (Claims) 
SAPI/FTP 
Provider 
MMAC Provider 
Enrollment 
Enrollment System 
SAPI/FTP 
servicenow. 
@ 2025 ServiceNow, Inc. All Rights Reserved. Confidential. " width="700" height="394" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-eaa4baa0c75d44459794a0dbdce1eaea!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-83c7cf527f5a4174a83ef7ce4857764b!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />





- ServiceNow Platform Overview – focus on process, data models, and integration capabilities :: Workflow platform to drive analytics, automation, customer and user experiences

- 
Demonstration (Megan)


- 
User Portal – The Entry Portal


- 





- 
Grievance Intake Form


- 
Public Sector 
Public Assistance 
> File a Grievence 
Search 
0 
File a Grievence 
File a Grievence 
Submit 
* Indicates required 
"Patient Name 
Required information 
Patient Name 
Date of Earth 
Complaint Details 
* Date of Birth 
DD-MM-YYYY 
Type of Complaint 
Medicine 
Date of Visit 
DD-MM-YYYY 
Location 
Siteman Cancer Center - South County 
Provider Name 
Dr. John Benson 
. 
Insurance Plan 
*Complaint Details 
Add attachments " width="618" height="449.5" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-c36ce0ce73454f9682c613e70e4a73dc!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-c36ce0ce73454f9682c613e70e4a73dc!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />


- If we expose this to the external parties outside of the agencies, we don't want to have the end person, end patient, to decide if it's a grievance or critical incident

- Based on what is happening, want to be data-driven to help determine the type on the backend and for the routing




- 
Form Submission + Portal Communication


- 
My Request 
Updated 
just now 
just now 
New 
CMPL0001046 
Actions 
Prinrity 
Complaine type 
Complaint details 
Intaloe 
4 - Low 
Doctor 
I waited in the roo ... 
Triage 
Research 
Respond 
Resolve 
Activity 
Attachments 
Paragraph 
BIY 
If you Have any questions, please call me at 507.360.8888 
Sand 
Derrick Bird 
just now 
CMPL0001046 Created 
Have a question? I'm here to help, " width="614" height="449" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-08886f94b6e940f79ea7027778cb445d!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-08886f94b6e940f79ea7027778cb445d!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />


- 
Q – Kim: What we were aiming for is a single entry system vs multiple portals. Also hopeful to have the ability in the form to 'bucket' certain themes 


- Dissatisfaction with the service receiving, service plan, service planning process – some of those additional opportunities to streamline so that we can retrieve data on the backend

- 
Initial discussions of the design or workflow


- GAP: Did not configure the data elements or the forms

- Kim confirmed that




- 
This is entirely configurable. It's meant to do that 


- Customize is changing the base code of the platform. 







- Kelly Harder – When we look at this, we are mapping the use cases but then bringing in the specificity from the business side 

- 
Q – Travis West: In this example, would the submitter be required to create an account or are they provided a unique code/ID to input to check the submission status?


- A simple explanation is - with ServiceNow, you can define the BEST business process, and the technology adapts to that. No longer do you have to bend your processes to fit the technology, the technology is built to fit your ideal processes.




- 
Kim – Aligning to the federal rules and compliance – need to meet that while making it as easier as possible


- Want the end user to come into the front door

- Something comes in as a grievance, but in the background, support that person for the 




- Jessica – goal really is to focus more on grievance, with the overall aggregation occurring on the next part




- 
Backend Routing


- 


- 
Corey – wanted to talk through being able to communicate back with the person or persons who wrote in the grievance?


- If they submit for the portal – unauthenticated vs authenticated – can control the grievance processes




- 
SLAs can be used in depth to track that work, who it's assigned to, pause, notification of potential breach


- If we are tasking out to an individual – have the capability through the workflow to proactively escalate to others dependent on how we want to configure that platform







- 
Reporting


- 


- 
Corey – Overall Question – Accessibility of the platform for individuals who use screen readers


- We have an entire part of our company who are dedicated to accessibility

- We have whitepapers and a bunch of content that we can share – heavily involved with other states to 

- 
Check out Accessibility here - https://www.servicenow.com/company/accessibility.html


- Following up after via email




- https://www.servicenow.com/accessibility-statement.html 

- https://www.servicenow.com/company/accessibility.html

- 






- 
Michelle with DMH – tied to what Corey is talking about


- The end user that is bringing in the information and filing and we need to 

- 
Can we make it a little bit more intuitive for that end user – could there be fillable fields such as Medicaid ID so it could pull back all of that information that they could then verify


- If the integration is in place, or it's already in SN




- Front – End, can that be switched




- 
Jessica – going back to the reporting screen and this is more downstream – is this just SN or could this be integrated


- This can be from any data, so long as it's pulled into SN via the integrations

- We have access to use external data sources to pull data from and aggregate into this reporting engine, or we can push the data out to tableau or powerBI

- It's one of those things – we always had to change business processes to adapt the technology. It's switched with ServiceNow – the tech fits the process







- 
Workflow Studio


- Defining the processes in the backend – build out actions and then workflows to meet the business process

- JSON Parser 
Parse JSON data and map to complex objects. 
4 
OpenAPI/Postman 
Import OpenAPI/Postman Collection specification 
and perform the required REST web service request. 
PowerShell 
Run powershell scripts on remote machines from 
your ServiceNow machine through a MID Server. 
|REST] REST 
Perform a REST web service request. 
SFTP 
Use SSH File Transfer Protocol to manage file 
transfers from source to target systems. 
- 
SOAP 
Perform a SOAP web service request. 
SSH SSH 
Run SSH scripts/commands on remote hosts 
through a MID Server, 
62> XML Parser 
Parse XML data and map to complex objects. 
https://demoallwfxea108871.service-now.com/$flow-designer.do?sysparm_nostack=trueff 
00 " width="696" height="404.5" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-74939a64f89c4a1b888df25a1c634b2d!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-7d9b6a425a5e4a748c2c3c0c0bc98d83!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />




- 
Complaint Case Created 
Flow Variables 
Trigger - Record Created 
Trigger 
Created 
Complaint Case Record 
Record 
* Table 
Complaint Case [sn_complaint_c ... X- 
Complaint Case Table 
Table 
Condition Add filters 
Run Start Time UTC 
Date/Time 
Advanced Options v 
Run Start Date/Time 
Date/Time 
Delete 
Cancel 
Done 
ACTIONS Select multiple 
+ 
Add an Action, Flow Logic, or Subflow 
+ Recommended @ 
Create Record 
Create Task 
Look Up Record 
Look Up Records 
QUpdate Record 
ERROR HANDLER 
If an error occurs in your flow, the actions you add here will run. 
Status: Modified 
Application: Global " width="693" height="394" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-dd570de732b649a3a03bbf1b82270a0a!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-3029d52ef5684261ad5691cffcee80b5!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />




- Flow Variables 
E 
Trigger - Record Created 
Trigger - Record Created 
Trigger 
Created 
Complaint Case Record 
Record 
* Table 
Complaint Case [sn_complaint_c ... X- 
Complaint Case Table 
Table 
Condition All of these conditions must be met 
Run Start Time UTC 
Date/Time 
- choose field -- 
. 
OR 
AND 
Run Start Date/Time 
Date/Time 
or 
New Criteria 
+ 1 - Post a Message 
Action Status 
Object 
Advanced Options v 
Delete 
Cancel 
Done 
ACTIONS Select multiple 
1 
THE 
Post a Message @ 
x 
G> Action 
§ Flow Logic 
¿ Subflow 
+ Recommended 
Create Record 
Create Task 
Update Record 
Create Task (legacy) 
Status: Modified 
Application: Global 
00 " width="740.5" height="378" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-3e27b9ae14ef4888835f00791b7a2cb6!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-6db8f513df6c491fb115e782bbf1990f!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />








- 
Additional Questions and Comments


- 
Workflow – we have multiple agencies touching one grievance – there would be the 'larger keeper' then assign it out to have multiple teams working on it


- Is it possible to keep that workflow in the system? Sub-Assignments and whatnot?

- 
Yes – what we do and how we function – have the ability to have subtasks to be assigned


- The case is always the parent – so we can send tasks out to different folks

- Ad-hoc and this can be configured as part of the business process

- Task gets it's own unique identifier and there are individual SLAs, notes, etc. Can see all of those tasks and the case will give you notifications when the tasks are closed off

- Tasks off of a case – track the work is getting done and within the timeframes we'd like for that










- 
Next Steps:


- Megan M to build out the updated form based on requirements

- Additional Follow Up as needed?






























--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


04/24/25 - Servos ServiceNow DHSS & DMH Incident and Grievance Process Discussion


Attendees: 


- Servos: Will Loving, Lauren Sparks, Megan Mulvihil

- ServiceNow: Paul Kilgore, Doug Bagley, Alex Althaus, Phil Calzadilla, | David Winton



Recording: ServiceNow_Servos_DHHS&DMH - Incident and Grievance Process Discussion-20250424_065933-Meeting Transcript.mp4


Notes:


Aligned on the goals of the demo and what types of use case and capabilities we'd like to see


ServiceNow_Servos_DHHS&DMH - Incident and Grievance Process Discussion.docx


Online HCBS Grievance System Draft 4.25.25.pdf




--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


04/18/25 - Servos and ServiceNow - MO DHSS & DMH Use Case Collaboration


Attendees: 


- Servos: Will Loving, Lauren Sparks, Megan Mulvihil

- ServiceNow: Paul Kilgore, Doug Bagley, Alex Althaus, Phil Calzadilla, | David Winton



Recording: not recorded


Agenda:


Notes:


The state must establish a minimum definition of critical incident that includes:


- Verbal, physical, sexual, psychological, or emotional abuse

- Neglect

- Exploitation

- Misuse or unauthorized use of restrictive interventions or seclusion

- A medication error resulting in a call or consultation with a poison control center, emergency department visit, urgent care visit, hospitalization, or death

- An unexplained or unanticipated death.








see page 9 for Incident reporting - https://www.medicaid.gov/medicaid/access-care/downloads/access-final-rule-slides-september-2024.pdf?utm_source=chatgpt.com


Here is what I found for Grievances: § 441.301(c)(7) – This is part of the requirements for 1915(c) waivers, which allow states to provide HCBS to people who would otherwise need institutional care.


- 
Requires states to have grievance systems for participants that include: 


- Clear procedures for filing complaints or appeals

- Notification to participants of their rights and how to file grievances

- Timely resolution processes




- 
§ 441.464(d)(5) – Related to 1915(i) State Plan HCBS


- Requires states to have a system in place for individuals to submit grievances about the services they receive, including access, quality, and appropriateness.




- 
§ 441.555(e) – Pertains to 1915(j) Self-Directed Personal Assistance Services


- States must have mechanisms that allow individuals to file grievances and appeals related to their service plans, support workers, or the administration of self-directed services.




- 
§ 441.745(a)(1)(iii) – Involves 1915(k) Community First Choice Option


- 
Requires that states must provide beneficiaries with: 


- Notice of action

- Right to grieve decisions regarding services

- Access to fair hearing procedures under Medicaid law











New Leadership in DSS – may be a good opportunity to go to follow up with residency


Residential center








Demo Feedback


- Hide bookmarks

- Single window

- Contextualize each page, what you are seeing and why – portal , workspace

- For demo data, have stuff already ready so you can copy + paste in

- Business users – do we really want to show the backend and how to configure these items? especially if we aren't using the most up to date tools (ie: catalog builder vs classic view)

---

# DSS LTSS Grievances Notes
(Last modified: 2025-04-21T16:29:45Z)

DSS LTSS Grievances Notes







> Date & Time:  2025-04-18 16:02:48


> Location: [Insert Location]


> Attendees: [Speaker 1] [Speaker 2] [Speaker 3]


## Overview


This document outlines discussions and action items from various meetings focused on Medicaid and LTSS program integration, networking and connections, disability services, ServiceNow platform implementation, and workforce challenges. The document highlights the complexities and inefficiencies in current systems, the importance of leveraging technology for process improvements, and the need for strategic collaborations. Action items are consolidated at the end to ensure clarity and focus on next steps.


## Integration of Medicaid and LTSS Programs


- **Complexity and Challenges**


  - Medicaid and LTSS (Long-Term Services and Supports) programs are intricately woven, often leading to complex situations involving trusts, wills, and estates.


  - Example: A client faced delays ranging from 35 to 130 days for discharge from a hospital to hospice care, highlighting inefficiencies in the process.


  - Hospitals incur significant costs, approximately $3,500 per day, due to these delays.


- **Process Improvement and Solutions**


  - A discovery process was conducted involving key staff and leadership, resulting in a redesigned workflow that reduced the discharge process to three days.


  - Technology was integrated to ensure consistency, continuity, and credibility in the process.


  - The solution addressed not just symptoms but also the root causes of inefficiencies in the LTSS process.


- **Collaboration and Expertise**


  - The solution was developed with eligibility and program teams working together, revealing a lack of clarity and assumptions about responsibilities.


  - The presentation of recommendations to leadership, including the human service director and the governor's office, was well-received.


  - The team involved has over 280 years of combined experience, including practitioners, advocates, directors, and agency leads, providing deep business knowledge and expertise.


## Future Engagement and Process Redesign


- **Involvement in Ongoing Conversations**


  - There is a desire to involve the team in every conversation moving forward to ensure comprehensive understanding and implementation.


  - The current project is seen as a potential entry point for broader discussions on process redesign.


- **Short-term and Long-term Solutions**


  - While the long-term goal is to redesign the entire process, there is an opportunity to implement small, immediate fixes to alleviate current issues.


## Networking and Connections


- **Importance of Connections**


  - Speaker 1 emphasized the value of being known by others, sharing a personal anecdote about working with Joni in the past.


  - Speaker 3 mentioned a personal connection with Sarah Smith, offering to facilitate introductions if needed.


- **Leveraging LinkedIn for Professional Connections**


  - Speaker 2 discussed using LinkedIn to connect with Sarah Smith, highlighting the importance of mentioning ongoing collaborations with Jerry and HSG.


## Children's Division and Disability Services


- **Complexities in Disability Services**


  - Speaker 1 discussed the separation of the DD system from the children and family system, highlighting the complexities of budgeting and waivers.


  - Toni's extensive experience in human services was noted as beneficial for understanding broader contexts.


- **State of Missouri Disability Services**


  - Speaker 3 confirmed that disability services are provided by DSS in Missouri, noting inefficiencies in the eligibility process.


  - Speaker 1 suggested that technology could improve these processes, which are currently outdated and inefficient.


## ServiceNow Platform and Missouri State Projects


- **ServiceNow Implementation in Missouri**


  - Speaker 2 explained the use of ServiceNow for Medicaid redetermination, integrating with MoHealthNet for streamlined renewals.


  - The platform's case management system was discussed, with examples of its application in adult protection and unemployment insurance.


- **Challenges and Opportunities**


  - Speaker 1 highlighted the need for understanding programmatic bottlenecks and leveraging technology to improve service delivery without overhauling existing systems.


  - Speaker 2 emphasized the importance of making informed decisions about what ServiceNow is suitable for, integrating it effectively with other systems.


## Workforce Challenges and Technological Solutions


- **Improving Social Work Processes**


  - Speaker 1 discussed the potential of technology to ease the workload of social workers, who often face outdated processes and technologies.


  - The high turnover rate among new hires was attributed to process inefficiencies and lack of engagement with modern technologies.


## Introduction and Networking


- **LinkedIn Connection**


  - Speaker 3 reached out to Sarah on LinkedIn to initiate a conversation, mentioning that her name had come up a few times.


## Upcoming Meeting Coordination


- **Meeting Setup**


  - Speaker 2 discussed setting up a meeting with Missouri, involving their team and ServiceNow.


  - Lauren Sparks, the client manager and delivery lead for Missouri, will be involved.


  - A recording of a previous meeting between ServiceNow and Missouri will be shared for review.


  - The meeting is tentatively planned for early next week, with the Missouri point of contact.


- **Meeting Participation**


  - Speaker 2 expressed interest in having all relevant parties attend the meeting.


  - Acknowledged the challenge of coordinating with multiple participants from ServiceNow.


## CWIS and APD Discussion


- **CWIS Opportunity**


  - Speaker 2 mentioned the potential opportunity in the CWIS division, now led by Sarah.


  - Noted that Missouri has not completed their APD, affecting the likelihood of a CWIS RFE this year.


- **Historical Context**


  - Speaker 1 shared past experiences with CWIS, highlighting ongoing challenges over the past four years.


  - Discussed the lack of personnel in offices authorized to modify and approve APDs.


- **Cost Debate**


  - There is an ongoing debate about the costs associated with CWIS, ranging from $40 to $60 million.


## ServiceNow and CWIS Market


- **Market Position**


  - Speaker 2 highlighted the difficulty in showcasing ServiceNow's use in the CWIS market compared to competitors like Deloitte and Salesforce.


  - Emphasized the importance of use cases from a business perspective rather than just technology.


## Action Items


- [ ] Involve the team in all future conversations regarding the Medicaid and LTSS process improvements.


- [ ] Explore opportunities for small, immediate fixes while planning for a comprehensive process redesign.


- [ ] Reach out to Joni or Sarah to discuss potential collaborations and mention the partnership with Servos and ServiceNow.


- [ ] Share project details and slides with relevant team members to provide a clearer understanding of ServiceNow's implementation in Missouri.


- [ ] Speaker 2 to send the recording of the previous meeting with Missouri.


- [ ] Coordinate and confirm the meeting schedule for early next week.


- [ ] Email details about the Missouri footprint and past work to relevant parties.


> **AI Suggestion**


> AI has identified the following issues that were not concluded in the meeting or lack clear action items; please pay attention:


> 1. Involve the team in all future conversations regarding Medicaid and LTSS process improvements to ensure comprehensive understanding and implementation. This is crucial for addressing unresolved issues and planning for a comprehensive process redesign.


> 2. Address the ongoing debate about the costs associated with CWIS, which range from $40 to $60 million. This requires immediate attention to resolve financial uncertainties and ensure proper budgeting.


> 3. Understand programmatic bottlenecks in the ServiceNow implementation and make informed decisions about its suitable applications. This will help mitigate project risks and improve service delivery without overhauling existing systems.


> 4. Explore the potential opportunity in the CWIS division, now led by Sarah, and address the lack of personnel in offices authorized to modify and approve APDs. This is essential for operational efficiency and effective project management.


> 5. Reach out to Joni or Sarah to discuss potential collaborations and mention the partnership with Servos and ServiceNow. This networking effort is important for fostering professional connections and exploring collaborative opportunities.

---

# OA ITSD - MO Citizen Portal
(Last modified: 2025-04-15T18:01:42Z)

OA ITSD - MO Citizen Portal








------------------------------------------------------------------------------------------------


9/06/23 - Review the SOW for UX


- Servos: Will Loving, Lauren Sparks

- ServiceNow: n/a

- MO: Ben Reinkemeyer, Dan Hlavac



Recording: 


- Ben noted the GDT project has been really busy the past year but now that all the enterprise tools are procured and in place

- User Experience SOW and what it entails on the Servos side

- Want to take a look at the UI Designs / Expectations of it

- Dan noted we have been separating that out

- Thing Dan is now looking for is the UI Design...if we wanted to bring a fresh look to even the MO.gov page, what does that look like and how to we move forward with the drafting, etc.

- There is a lot of work

- Separating the conversation in terms of UI Design

- 
SD & MT Approaches


- UI/UX Designs and Aspects of it were different as well

- In MT started at the Govenor's office

- 
In SD started with all the agencies and buy-in and that drove the user experience based on priorities and what


- Gov office got to the end

- Opinions – whether or informed




- MO: One of the things we want to do is we aren't pulling in the other




- 
UX Design – initial Design and what rolls out first


- Once we have login, what does that mean

- Change of address and status stuff and what we put in there

- Rolling that out and what we get out of there




- 
Dan – break this up a little bit. Want to break out the enterprise services


- Want to look at the UX design research and the build of the portal page itself

- Separate that from enterprise services

- 
Strategy:


- Mo.gov (unauthenticated)

- Logged in > my.mo.gov

- This is where we will need some expertise




- Next Steps: Relook at the SOWs and separate out the Enterprise S

- Do like having an SOW




- 
Two SOWs


- 
One


- Design




- 
Two


- Communication Preferences

- Change of Address

- Status







- 
If we head towards a SOW, when would you want to get started...3-4 weeks


- Want to bring in the additional architects onboard

- Provides some integration and oversight across all projects

- Kelly & Rebecca Moyer




- 
Dan wants a meeting to discuss our experience working in WIC – that meeting request will be coming as well


- WIC will require a pre-conversation




- 
Family Care Safety Registry – Do we have a meeting scheduled – thought Will was invited this week


- Dan to follow up on this and will be talking with them and moving forward with them as well

- Will need an SOW

- How much engagement is going to be needed and how do we work through these things




- WIC will req



------------------------------------------------------------------------------------------------




8/03/23 - MO DED | Servos: CRM & Grants Implementation Proposal Scoping Follow Up


- Servos: David Hurley, Lauren Sparks, Matt Miller, Will Loving, Joe Garcia

- ServiceNow: n/a

- MO DED: Steven Tackett (BRM), Kayla Kuckelhan (poc), Brent Gohlson – put on the project for the project manager. Bringing Brent up to speed



Recording: <RECORDED ON WEBEX – obtain recording from Kayla>


Notes:




08.06.23


Citizen Journey Priorities:


- Foster Care Safety??

- Veterans Portal

- Employment Opportunities

- WIC tax credit application

- Status of benefits







My MO.gov - Citizen Portal


3.28.23



- 300 prioritized citizen services out of 1,000 according to Jeff Wann – CIO

- Multiple people from MO have said they are planning to implement Educator Certifications as the first major workflow on MO.gov by December?





Attendees: 


Notes:




Attendees:

---

# DSS CD - CCWIS Strategy + RFP
(Last modified: 2025-02-17T21:49:09Z)

DSS CD - CCWIS Strategy + RFP







02/13/25 - Winton Lobbyist call with SN and Servos


Attendees:


- Servos: Will Loving, Pat Snow

- ServiceNow: Paul Kilgore, Doug Bagley

- Lobbyist: David Winton





Notes:


- David doesn't think CCWIS will need to go to a full procurement - currently no CCWIS RFP is even in development

- Joanie Rogers will likely run and the new CD Director - Sarah Smith is a friend of Winton

- Jessica Bax is a friend of Winton and said that after she is confirmed this week - her plan is to look at all IT projects in DSS and will stop some and put emphasis on others

- Winton is pushing for language to be in all RFPs and funding requests to require MO to use existing systems where MO has already paid for an enterprise license versus buying other software

- We discussed the challenges MO has with making forward progress on the My.MO.gov citizen portal - procurement hurdles and lack of senior leader driving it from OA ITSD and/or an agency.

- Winton is gathering feedback so he can push this with Laurent and Paula - he is also going to push the IT Services QVL with ITSD procurement - what's the hold up since August 2024

- Next steps is Winton wants to put together a "road show" to show agencies, IT and some of the legislature what types of use cases could be put on the My.MO.gov ServiceNow platform. There's a junior state senator on the appropriations committee that Winton wants to arm with this information. Winton wants to make a list of 3 key things that Laurent needs to clear out of the way so OA can make progress on the citizen portal and leveraging the platform.





02/13/25 - Discuss MO CCWIS strategy with Servos/SN PS


Attendees:


- Servos: Will Loving, Meghan Holt, Megan Mulvihill, Pat Snow

- ServiceNow: Paul Kilgore, Aaron Marx, Darris Adkins, Andy Martin





Notes:


- Discussed response approach to potential CCWIS RFP - ServiceNow PS prime, Servos SN Lead, Evolv CCWIS SME, maybe eSystems for integration work

- 
Consensus was we need help from David Winton on the following:


- Get in front of new DSS leadership - Jessica Bax (Commissioner - getting confirmed in week or so), Joanie Rogers (CCWIS lead) and new CD Director - Sarah Smith - to tell them about the platform and remind them they own it already and it's made for case management use cases like CCWIS

- Identify what the big CCWIS issues are currently with FACES and other aspects - so we know what to focus on during the business-level pitch

- Identify some low hanging fruit in and around CCWIS that we can build on the platform to help them get some quick wins and see the value




- Weekly checkin call with Winton and SN is scheduled for Thursday at 3pm CST - Paul K invited Pat and Will to join





02/06/25 - Discuss MO CCWIS strategy with Servos/SN PS


Attendees:


- Servos: Will Loving, Lauren Sparks, Meghan Holt, Megan Mulvihill, Matt Miller, Pat Snow

- ServiceNow: Chris Dilley, Paul Kilgore, Jason Swett, Aaron Marx, Darris Adkins





Notes:


- 
Aaron comes from Deloitte + has CCWIS experience, experience in SLED just new to SN. Covers Federal + West Plains Territory at SN


- Jason is here to support Aaron. 

- Been at SN for 8 months – career in the marines as an aviator + stood up license sales in public sector

- Selling Services here now at SN




- 
At Servos has been on the CCWIS train for a while + working with SN to put the best foot forward to upset the current path


- Our goal for this call is to meet Aaron and understand his background

- As a partner of ServiceNow, have less Domain Experience but are partnering with Evolve (Carole's team)




- 
Strategy


- Aaron has sold CCWIS + SNAP – has sold this everywhere except in MO

- 
Accenture has the focus of the IT department + Accenture has been on the outside looking in + now doing the DYS


- Beside CCWIS




- It will be hard to pitch Accenture to go in on CCWIS + use ServiceNow

- Guess Accenture will bid on it with Salesforce

- This CCWIS is a net new opportunity + pre-rfp

- 
Aaron – the clients want one throat to choke + they only want one person to go to


- Just because they have the name brand in other states 

- If the account wants to prioritize Servos over some of our other partners – doesn't care

- Prefer our partners to be a part of our delivery, but want to be on our paper




- Think they want to build it with something they already have + MO is trying to be a SN first state

- 
Background on where they are at with the process – what do we need to be doing to influence the RFP


- Dilley has the support from Mike + pushing up the chain

- 
What do we need from a resource perspective to win + influence this


- We need to get that in front of David Winton + talk about how we could own it from the SN perspective

- SN primary + working with partner + OCM

- Give him an overview of what we have so far + a meeting with David would help us calibrate that and he can help position getting the meetings with Joanie + Jessica Bax + (Kayla??)




- 
Who else to we show our Demo to and have the internal team look at it + throw out ideas before going to Winton


- Aaron needs to see it + 







- 
Paul's Perspective on Winton is great


- We need to give him the talking points and the partner strategy – that SN will pursue this

- 
Where we've been most vulnerable is how we'll deliver this if we have never done this before


- 'get the confidence on the project management....

- 
Need to be very constructive with 'what parts will come first'


- Incremental implementation over time

- Need to have a semblance of a plan so that they feel comfortable










- 
RFP is in process + it's in review with ACF


- Darris to follow up




- Need to put in the request to have this team to get involved + their probability of win % increases when they are involved early








Actions:


- Deliver the TX CCWIS demo to SN for their internal review - Matt

- Schedule internal demo for SN / Winton + review sales collateral – target next week – Will/Lauren

- Determine status of RFP – when it'll be released – Will / Darris

- 
Begin clarifying the 'implementation strategy' including: 


- the teaming model w/ SN – Servos – Evolve 

- Iterative implementation – what do we start with

- OCM




- SN to start pulling in + prepping their RFP team

- Review MO website + familiarize with assets + strategies/priorities discussed: https://dss.mo.gov/cd/professional-stakeholders-resources.htm







--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------




12/30/2024 - CCWIS Strategy discussion for pursuit


Attendees:


- Servos: Will Loving

- ServiceNow: Chris Dilley, Paul Kilgore, Doug Bagley





Notes:


- RFP is going to be written for an "existing platform"

- Dilley/Darris - wants to know what they could be doing ahead of RFP to help

- Dilley asked about Servos plans - leveraging Carole/Evolve, teaming strategy

- Mike Hurt is willing to nudge or shove Accenture to bid on the MO CCWIS - said they are leaning a different direction on MO for CCWIS - but didn't say no yet. Accenture regional and account leads for MO said NO to go with ServiceNow

- Dilley - asked what is the licensing cost for Salesforce for CCWIS - compare to what ServiceNow a la carte cost or enterprise licensing cost

- Doug - asked if we could put together a plan for how we would iteratively implement - given we know the systems - John Laurent is not positive on Salesforce - would want to do SN if we can show him how

- Dilley/Mike Hurt - putting together business case to get the resources we need - Chris wants to also show the risk of not getting it - debook licensing if they don't want it





Actions:


- Paul to put together licensing cost for SN 

- Will to send questions to Paul about MO structure - but check with Carole first

- Will to look at iterative implementation framework - leverage Virginia example Bobby put together - can we build something for MO?





Other intel:


- DSS not happy with Conduent and their Child Support project - Hexaware left early and ITSD had to finish up and clean up their work









--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


06/17/24 - Discussion on Robert Knodell Conversations and Scheduling


Agenda: Connecting to discuss Logan’s conversation with DSS Dir. Rober Knodell and next steps on providing more information or an engagement on scheduling capabilities.


Attendees: 


- Servos: Lauren Sparks, Will Loving

- ServiceNow: Paul Kilgore, Doug Bagley, Logan Pinckney



Recording: <RECORDED ON WEBEX – obtain recording from Kayla>


Notes:


- 
Logan's Debrief with Knodell


- HL conversation – CCWIS RFP is coming out soon – long process

- Want some quick wins – case worker scheduling

- Get in touch with Winton with Daryl Missey to get the quick win




- David Meets with Daryl – will not be included in that sync up – David has a lot to sync up on so SN or Servos will not be included in that

- 
Use Case: Case Worker Scheduling


- 
Children's Division Case Working Scheduling – to Schedule their Monthly Appointments that They 


- 15+ Cases

- May need to schedule time with the provider, the family, the child

- Take it out and put it in email and email the folks

- Will call them if they don't hear back

- 
Phase 1: No emails


- Instead of entering into Outlook, enter in SN, update the schedule, then book time on the calendar to schedule those meetings

- Integration with Outlook? Don't need it. Can manually put in 'here's the day I'm free for meetings' and depending on meeting type or location, blocks the time after

- Did a high-lev, but never a deep 




- Was this the ride along? Yes

- Who saw this the first time around? Jennifer Tidball [COO spot at the time] and Adam Crumbliss in the meeting, Don't think Daryl or Dir Knodell seeing this or being in the positions at this time







- Goal: Get Daryl to say 'yes' to solving this problem now. 

- 
If there's interest and if they do want to do something – figure out how to get support from Daryl to cut through the red-tape for procurement and who will do the work on some level of a small engagement to get going.


- Was hoping we'd be on the call to get through it.

- Similar to that regard and took it very well. All one team when we look at this. Going to run into the issue(s) with procurement.

- Think he's comfortable pre-qualifying that. Trying to get across.

- Kim Evans on the FSD side has a lot of clout and she's getting




- 
Since no one will be in the meeting with David – do we need to write him up some talking points?


- Logan – we can. He's been through it but can give him a bit more in case he needs that

- Will come out with some pre-qualified appetite. May need to have another TB with him. Get Daryl to say 'yea we'll meet'

- David is bridging the relationship

- It's not like they don't have any money …. just need to get it right




- 
Separate Work: Foster Parent Portal Use Case in the Instance Currently


- Don't know how much the CD team has been engaged with this

- Foot in the door on the platform – another way to build on top of that




- 
CCWIS Modules within the ATF – don't know where this scheduling would fit into the broader CCWIS discussion


- 
After the meeting and there's interest – they may say they want to see something. Is that something could do a demo?


- Paul – recap this slide deck – validate that this is still accurate and on-point. once validated can pull together a deliverable to refresh the use case a bit

- $10.5M 
*Number Based on Team Findings " width="720" height="328.5" src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-87163c6325bc42eeb67adabf9d8a6682!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-src-type="image/png" data-fullres-src="https://graph.microsoft.com/v1.0/siteCollections/servosio.sharepoint.com,cc999b8c-7b3b-42fa-8b78-853029dd094f,4a38c317-8bb1-426f-b9df-b87ce88e724d/onenote/resources/1-e7fc16761d9e498ab7fa78aba3b84269!1-0034a671-bb57-468c-b5a7-7daa6428cbdf/$value" data-fullres-src-type="image/png" />





- What other low-hanging fruit and high-paying workflows are out there?

- ACTION: Will to send 4-5 bullet points for suggested talk points to the SN team. 




- Logan – Most CCWIS solutions won't call this out or include it initially

- 
Will – CCWIS


- DMI – working with them on a project in Maryland

- Larger than us and do a lot of work in state government

- Implemented CCWIS in Maryland (custom app) and have SMEs – have spoken about our CCWIS POC. If and when this drops for an RFP, may entertain responding with them

- 
Logan – one other to consider may be Redmane – just with their standing in the state and they claim they are doing 4 different state's CCWIS right now


- We are familiar with them and Pat Snow kicked them out

- .net based product

- Redmane that is working with FSD – goes back to their backend solution and could be something to look at partnering with Curam











Logan Pinckney<logan.pinckney@servicenow.com>


To: Will Loving; Lauren Sparks 


Cc: Paul Kilgore <paul.kilgore@servicenow.com>; Matt Miller; +4 others 


Wed 6/12/2024 10:27 AM





This sender logan.pinckney@servicenow.com is from outside your organization.


Block sender


This sender logan.pinckney@servicenow.com is from outside your organization.


Regarding the Case Worker Scheduling, Director Knodell was looking for quick wins and this fit perfectly. When we sat with case workers, they were taking email addresses from FACES (each month) and emailing everyone they needed to meet with some significant back and forth before they could get an appointment scheduled. The vision we had put together was for case workers to enter in the email address and basic info from FACES into ServiceNow the first month and then they would just have to review the info for future months. Once the info was in ServiceNow it would automatically send the emails for scheduling with availability of the case worker (they would show blocks in which they were free, including travel time). ServiceNow would also be able to follow up if the appointment was not scheduled so that the case worker did not have to do a majority of the follow up.




This initial setup would require no integrations as take a significant lift off the case workers. There were other efficiencies that we could help with going forward once this is in place, but this is the quick win that Director Knodell was excited about.




For the CCWIS conversation, I asked the question “would it be significant to leverage licensing that the state already owned to save money” and he said that could be a big part of it. I know there are other partners in the state for contracting and that have strong relationships, so it may be valuable to partner with them. Evey with the additional cost that they may add, we should still be able to come in significantly less than a GSI pushing SFDC or then a Redmane or Binti solution.




I think we push heavily on the value of the licensing they already own, along with the ability to deploy the different modules in an agile approach to provide value along the way of the “3-5” year project journey that Director Knodell referenced for a CCWIS project.




Happy to jump on a call to discuss more.




Regards,




Logan Pinckney


Government Solutions


(m) 952.454.1145
























5/11/23 - CCWIS Introduction to DSSS


Notes


- Adam Crumbliss - Deputy Directory of DSS - Adam Crumbliss | LinkedIn

- Angie Swarnes - Deputy Director, Permanency, DSS - Angie Swarnes | LinkedIn

- Brooke Goff - Senior BA - Brooke Goff | LinkedIn

- Christopher Kimsey - Regional Director - NW Region Childerens Division - Chris Kimsey | LinkedIn

- Heather Ford - Foster Care Program Manager - Heather Ford | LinkedIn

- Jennifer Blankenship Loibl - Supervisor, Children's Division - Jennifer Blankenship Loibl | LinkedIn

- Kelly Bungart - Business Analyst - Kelly Bungart | LinkedIn

- Kyle Kendrick - Regional Director, Childrens Division DSS - Kyle Kendrick | LinkedIn

- 















Attendees











- 



- CCWIS

- Foster Care Portal

- VitalChild

- SN demo - intake, case management





- DSS folks are replacing CCWIS system and Foster Care - was heading down MS Dynamics path - cost prohibitive but still considering going down the path

- Convinced them to look at what they have with VitalChild

- CCWIS and Foster Parent Portal and show them those things

- 7-10 days

- ROM - can we do that? Ball Park

- Adam Crumbliss - Knodell

- Tie in heavily with what we are doing with DSS





 


Demo of SN partial and Oracle VCVC CCWIS on 5/25/2023:


- 
Doug Star provided the feedback after the meeting:


- Missouri DSS has very little appetite for not OWNING the code and software they pay us to build - licensing will need to change

- Foster Care Portal is the main focus and DSS is under the gun to get something live to show by December - they want to do this ASAP and not sure about the full CCWIS

- Since MO would be the FIRST state to implement CCWIS on ServiceNow with it being the first VCVC and Servos project of it's kind - they are asking for a discount since they will be funding the development of the solution the VCVC will go sell to other states

- MO feels like VCVC is selling a "system" vs. software and are being too prescriptive about process, forms, etc. - MO wants more flexibility

- MO really wants to work with Servos and ServiceNow - they are not certain they need VCVC






 


Proposal to MO DSS:


- Start with Foster Care Portal (revise previous proposal) - leverage VCVC SMEs as billable resources on the project - Servos prime and lead

- Solution will be built by Servos on MO ServiceNow instance and code will be owned by MO

- VCVC for CCWIS will be a TBD and continued discussion as MO determines a path forward for CCWIS or not



 


Proposal to VCVC on moving forward:


- VCVC to act a SMEs on the MO FCP project (block of hours over course of project or 1-2 roles part time)

- Build the FCP project with a CCWIS informed approach - Keep IP separate - code will be owned by MO, not VCVC or Servos

- Servos will leverage what is built for MO as a model for VCVC continued build

---

# DSS YSD - Case Managment
(Last modified: 2025-02-05T16:05:35Z)

DSS YSD - Case Managment







DYS PAQ Response


03.11.24




Notes:


PAQ Definitions


- Shall / Must = Hard requirement & must-have

- 
Should / May = nice to have...try to include


- 
Karen WWT – summarize the timeframe in terms of the start date and end date...when the warranty is and when the 6 months of post production and how that works together


- 
Oscar – PAQ specifies the proposed estimated start. Project starts middle of April


- Propose how long we think it will take

- Warranty period starts after we go into production







- Allocated Budget

- Existing Vendor – no

- 
Cesar Mayers – Accenture


- Process & requirements document 2.3.1 has a list of interfaces and program names – can the state can provide what technology these programs are using

- Oscar – will not be sharing the details of the old system – please review the requirements

- Assume that you will use new and modern technology to connect with these programs and ITSD will make sure we can get those technologies 




- Relationship with Oscar – on this project as a PM and that is the role he is serving for this project

- Signature – scan it in and email when sub






Questions:



# | 
Source | 
Question | 



01 | 

From PAQ Document page 6 states: 


"Convert all data from the current On-line system (source and target record balance report)"



| 
What are some of the security considerations or constraints when migrating this production data from the legacy system to the new CMS? Can the data conversion or migration activities be done via a flat file? | 



02 | 

Document: PAQ Document 


Page 6 states: "Conduct unit, system and integration, including system connectivity testing..."



| 

Can the State provide their definitions of each of the following testing types for clarity and alignment to expected deliverables:


- Unit testing

- System testing

- Integration testing


| 



03 | 

Document: Current Processes and Requirements v2


Section 2.1: "There are approximately 1500 staff supporting DYS, but only the office support staff and clerical are current users of the DYS Online Information Management System

| 
Will all 1500 support staff need access to the new system? Or will the new system need to be accessed by the clerical staff? If so, what is the estimated # of staff requiring systems access? | 



04 | 

Document: Current Processes and Requirements v2



| 
The process today is very manual and paper-heavy. We see some requirements to create forms leveraging data from the system (an output). Is there the desire to go completely digital for data collection / data intake and move away from paper (ie: a service coordinator uses a computer or mobile device during data collection activities vs a paper form)? Or do we imagine that there will still be intake or note taking activities occurring manually with the need to get those translated into the system more efficiently while maintaining the paper distribution options? | 



05 | 

Document: Current Processes and Requirements v2


Section 2.2.3.1: "The request is mailed to the last school attended with a copy of the request placed in the youth's Official Case file and a copy mailed or faxed to the DYS site providing educational services for placement in the educational file. The Request for Student Records is not captured in the On-Line system."

| 
For situations or use cases where a form or letter is generated for mailing, can emails be leverage where appropriate? Or are there legal requirements about mailed communications | 



06 | 
n/a | 
Is there a need for an external user facing portal (ie: for youth, parents, courts, schools, or other entities to interface with DYS? | 



07 | 

Document: Current Processes and Requirements v2


Section: 2.2.4.8.2 : "Although the ability to update this screen is limited to DYS Central Office authorized employees, the screen may be viewed by Department of Social Services Family Services Division and Children's Division Eligibility Specialists as well as MO HealthNet Division employees who process federal eligibility benefits"

| 
Will these divisions require read-only access to the new system? | 



08 | 

Document: Current Processes and Requirements v2


Section 2.3: "DYS maintains two numbering systems for committed youth.The first is a five-digit number/alpha character followed by an alpha character which indicates region of commitment. This system includes youth committed to the division with a standard court order. The second numbering system contains an alpha character identifier followed by a four-digit number/alpha character followed by a regional identifier. This system is used to identify youth committed under special conditions. Such conditions are cases involving victim rights, determinate sentencing, dual sentencing, status offense, or dual jurisdiction. After transaction SCLR has been reviewed, a DYS number is assigned and identifying and pertinent data is entered on the Y001 menu. This data is to be entered within 48 hours of commitment. Each region has set guidelines for this process."

| 
Are these numbering systems unique? Once assigned, do these identifiers ever change? | 



09 | 
n/a | 
Will the state need to complete of update any data sharing agreements with other departments (ie: DESE, DHSS, DMH, etc.) before allowing any data within the new system (for testing and production purposes)? If so, will these activities have any schedule or timeline impact to the project's activities? | 



10 | 

Document: Current Processes and Requirements v2


Section 2.3.1: Tables showing Programs and Common Calls

| 
Are these programs and calls existing web-services or integrations that can be leveraged to connect to the new system? Or will the State need to create new webservices as part of the project efforts? | 



11 | 

Document: Current Processes and Requirements v2


Section 3.2: "DYS CM Matrix.PDF - Case Management Use Cases"

| 
We never received a document titled this. Can you please share this document: DYS CM Matrix.PDF - Case Management Use Cases? | 



12 | 
n/a | 
For deliverables requiring use of Microsoft tools such as Visio or Project, will the State provide the vendor access to those systems on the State network to allow for collaboration and visibility to project efforts? | 



13 | 

Document: Current Processes and Requirements v2



| 
Is the state clarifying that UAT will occur in the TEST environment prior to a pilot of they system in PROD? Is the pilot program expected to occur in TEST or PROD? Appreciate the clarification | 



14 | 

Document: Current Processes and Requirements v2


Section 3.2.13: "DYS CM Matrix.PDF - Case Management Use Cases"



| 


| 



15 | 
n/a | 
I don't believe all requirements and files were shared with the original distribution. Is it possible to receive an extension to respond to the PAQ based on the receipt of the requirements shared on 03/07 and the additional file being asked today 03/11? | 








--------------------------------------------------------------------------------------------------------------------------------------------------------------------------


Case Managment Solution Overview - MO/Tshibanda/ServiceNow







Subject | 
Case Managment Solution Overview - MO/Tshibanda/ServiceNow | 



Link to Outlook Item | 
Click here | 



From | 
Paul Kilgore | 



Required attendees | 

Paul Kilgore


Lauren Sparks (Tentative in Outlook)


Joe Garcia


Logan Pinckney


David Hurley


Will Loving


Jacob Searls


Dan Hlavac


Oscar Tshibanda


Eric Borgman


Starr, Doug

| 



Optional attendees | 

Doug Bagley


eborgman@tshibanda.com

| 



Meeting Date | 
7/7/2023, 11:00:00 AM | 



Location | 
Microsoft Teams Meeting | 






---

From: Paul Kilgore <paul.kilgore@servicenow.com>

When: July 7, 2023, 12:00 PM - 1:00 PM 

Subject: Case Managment Solution Overview - MO/Tshibanda/ServiceNow 



Case Management for Division of Youth Services (DSS) 



Intros 

Voice of Tshibanda 

Overview of Case Management 

Expected outcomes 

Examples from other states (Servos) 

Q&A 

Next steps 



________________________________________________________________________________ 

Microsoft Teams meeting 

Join on your computer, mobile app or room device 

Click here to join the meeting< https://teams.microsoft.com/l/meetup-join/19%3ameeting_NWQ2MWI2MzctZmVmMC00MzE2LThmNTMtOGNlYWYzZWJhNDBh%40thread.v2/0?context=%7b%22Tid%22%3a%228bcff170-9979-491e-8683-d8ced0850bad%22%2c%22Oid%22%3a%22cccbb6a6-d6e2-4256-8949-dcb492ede09f%22%7d>

Meeting ID: 285 428 786 437 

Passcode: Ju7GwB 

Download Teams< https://www.microsoft.com/en-us/microsoft-teams/download-app> | Join on the web<https://www.microsoft.com/microsoft-teams/join-a-meeting>

Or call in (audio only) 

+1 619-483-4099,,319285378#<tel:+16194834099,,319285378#>   United States, San Diego 

Phone Conference ID: 319 285 378# 

Find a local number< https://dialin.teams.microsoft.com/f907cef6-027f-473f-94c6-77e0ff9ce56c?id=319285378> | Reset PIN<https://dialin.teams.microsoft.com/usp/pstnconferencing>

[ https://dg01.redatatech.com/onprem_image_fetch?dep=j07ooqCc7zcmzcZLQXB9kQ%3D%3D%2F09hwGL%2Bauvov5%2BE4A3hebmfrohIfNwuhLezNVtmTVROnw7fTrO8idtqoQPG23fLH%2FBFz87GUiclgTwUVfzU2dd9MkPrQ5zSz84YxXjNvlikRv5vKnlhru7KAwhor9Ul7xLYfOvWxALS88IR3UmTgnZrDfXEt0RDl%2FJl5HqCUBmnB4iP7eMKHBMvv3xc6S9l3tp2130cQbgaHTCazCpsLVbOG5at9p4IA2Q%2F1VDs5I0ZGzCicITg5zvQO22B0aV8IVPMDm5oIl%2FSCmh0moeRtSVC06o3oei55E8AKNnHWy34SKcBVC5xnWbTShxnU8yTPQLhiZM5SQx2FfTW5qXK6d9gVb4deNzW%2BMSILqFfKVUuSMuvGL00ffQD8i5Bo7nZc6Ue8a%2Feah2gVUadmbqdWfNBF0yX98%2FMOdlm0wOI%2FCt9fncdOkwSIOTQR7gYrx8KqVkSmlbNeekcwHCKoXGik7HLdKzH3LZK5IkQLgSxEwtlr3dU0XXdxmByFtt2yrJr]

Learn More< https://aka.ms/JoinTeamsMeeting> | Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=cccbb6a6-d6e2-4256-8949-dcb492ede09f&tenantId=8bcff170-9979-491e-8683-d8ced0850bad&threadId=19_meeting_NWQ2MWI2MzctZmVmMC00MzE2LThmNTMtOGNlYWYzZWJhNDBh@thread.v2&messageId=0&language=en-US>

________________________________________________________________________________ 




### Notes


- 
Platform Overview Slide


- 
Q: If we have rule, where do those reside? Example: If you receive a call someone was committed and x number of days to create reports, where would those rules resign. Is that a separate rules engine or is that a part of platform?


- Yes to both. Can hook into an existing system if that already exists.

- Most customer embed rules or business logic into the platform. What was described would be more of an SLA and that is OOTB functionality to set the clock and track those metrics and workflows. In this example this is built into the workflow

- Business rules can – use decision trees and decision tables that are configured in day to day business tools to build out decision steps in the process, can also build the flow.

- Don't need to have a whole project around changing the scope of one workflow or one business rule.




- 






- 
Overview of DSS FSD Benefit Portal


- FAMIS & MEDES Eligibility System Connections

- Q: Is this real-time? Yes

- 






- Overview of 









Email threads:


From: Starr, Doug <Doug.Starr@oa.mo.gov>

Date: Friday, July 7, 2023 at 10:51 AM

To: oscar <oscar@tshibanda.com>, Odum, Scott <Scott.Odum@dss.mo.gov>

Cc: Paul Kilgore <paul.kilgore@servicenow.com>, Logan Pinckney <logan.pinckney@servicenow.com>, David Hurley <dhurley@servos.io>, Will Loving <wloving@servos.io>, Jacob Searls <jacob.searls@servicenow.com>, Hlavac, Dan <Dan.Hlavac@oa.mo.gov>, Eric Borgman <eborgam@tshibanda.com>, Doug Bagley <doug.bagley@servicenow.com>, eborgman@tshibanda.com <eborgman@tshibanda.com>

Subject: RE: Case Managment Solution Overview - MO/Tshibanda/ServiceNow


Good morning,


Very helpful and thanks for the information and summary.


Doug




From: Oscar Tshibanda <oscar@tshibanda.com>

Sent: Friday, July 7, 2023 9:32 AM

To: Starr, Doug <Doug.Starr@oa.mo.gov>; Odum, Scott <Scott.Odum@dss.mo.gov>

Cc: Paul Kilgore <paul.kilgore@servicenow.com>; Logan Pinckney <logan.pinckney@servicenow.com>; Hurley, David <dhurley@servos.io>; Will Loving <wloving@servos.io>; Jacob Searls <jacob.searls@servicenow.com>; Hlavac, Dan <Dan.Hlavac@oa.mo.gov>; Eric Borgman <eborgam@tshibanda.com>; Doug Bagley <doug.bagley@servicenow.com>; eborgman@tshibanda.com￼Subject: Re: Case Managment Solution Overview - MO/Tshibanda/ServiceNow




I am sorry for any misunderstanding. We had planned to hold meetings preceding this one with ITSD, but circumstances delayed those meetings. I understand how this may seem out of sequence.


I am a contractor for DYS, serving as their Project Director. I keep Scott Odum, DYS Director, appraised of our activities weekly. I will report the results of this meeting to him later today and next week. I am copying him on this email as well.


The current DSS budget includes an appropriation to replace DYS's Case Management System. We are in the process of developing use cases, key requirements and presentations to ITSD. We are also conducting a market survey to understand systems used in other states and identify available third-party solutions.


We have begun an effort to contact ITSD and have consultations. Director Odum had a meeting to discuss this effort with Jeff Wann, but Jeff resigned the previous week. That meeting is in the process of being rescheduled. I mentioned this to you at the FSD Vendor Roundtable and at the Digital Government Summit. I followed up our chat at the Summit with a couple of emails seeking a meeting with you and several IT leaders to discuss the project and seek guidance.


In previous interactions with Jeff Wann, John Laurent, Paula Peters and Dan Hlavac, I understood that ISTD wanted state agencies to reuse enterprise IT assets to avoid the proliferation of unrelated, duplicative solutions and facilitate integration. It is in that spirit that I requested this call. The objective of the call is to understand the capabilities and offerings of ServiceNow, ITSD's preferred low-code development platform. We are only collecting readily available information to include in our presentation to ITSD.


Following this call, we have planned reviews with Director Scott, his leadership, managers and staff. I would love to follow up with you to discuss further. I hope this helps. Thanks.


Oscar Tshibanda

Tshibanda & Associates, LLC

Managing Partner

(816) 916-7171




On Fri, Jul 7, 2023 at 7:25 AM Starr, Doug <Doug.Starr@oa.mo.gov> wrote:


Good morning all,


Sending a quick note to see if I can get some guidance/feedback on the purpose of this meeting. I am not aware of DYS ever expressing a need for a case management system, but I will fully admit that I am least familiar with them out of all the DSS divisions.


I am also concerned we are having a conversation about a DYS case management system and there is not a single DYS staff member invited to this call.


Any input or feedback anyone has would be greatly appreciated.


Thanks,


Doug

---

# 10.16.24 Kim Evans – MO DSS Feedback & Partnership 
(Last modified: 2025-02-04T22:14:01Z)

10.16.24 Kim Evans – MO DSS Feedback & Partnership 








FSD Benefits Portal – Phase 3


- 
Scope:


- 
She wants to do more work enabling document upload capabilities. 


- Noted it would be nice for constituents to have a case or receipt they can refer back to so that they know their documents were received by the state.




- 
She wants to improve the way status is tracked and displayed in the portal for all IM applications:


- SNAP Applications & Renewals

- Medicaid Applications & Renewals

- TA Applications & Renewals




- She acknowledged that without employee process changes to start leveraging ServiceNow, that integration would would need to be done and that would require time and commitment from the technical teams [FAMIS & MEDES teams].




- 
Timeline & Funding:


- She's submitting supplemental budget request to continue the portal work and would expect that to be approved in Feb 2025

- Sarah Kent previously confirmed this timeline as well....so hopeful this will kick off next year. A PAQ would need to be issued.








ADA Compliance Form & Case Management


Spoke with Kim Evans on 10/16/24. Kim very much was appreciative of the FSD Benefits Phase 1+2 efforts and sees Servos as 'her vendor' for ServiceNow and FSD Benefits Portal work. 




She noted that they will likely need to execute quickly on an 'Emergency Request' this Fall regarding an ADA Compliance issue for SNAP applications (and really any IM Benefit).￼


Use Case: Currently, FSD does not have ADA Accommodations for their IM Benefit Program Application processes. There is a lawsuit MO DSS is attempting to settle right now for SNAP: https://nclej.org/snap-highlights/federal-court-rules-missouri-violated-snap-law-and-the-ada. Kim will be involved in an all-day mediation on Friday 10/18/24 with the expectation that they will finalize next steps for how to settle and the corrective actions FSD will need to take to get into compliance based on the lawsuit rulings. She noted that the timeline would be dependent on 'the vendor' (she confirmed as Servos with me during our conversation). 




Currently, Kim is anticipating FSD will need to to the following:

- Create an ADA Accommodation Request Form that FSD Staff will need to receive and process.

- Have the ability to perform clear reporting that will need to be delivered to the Courts to prove compliance.

- Allow The Office of Civil Rights Access [use case not well understood at this time - data sharing agreements in place]

- Though not discussed....it's possible the scheduling or making a SNAP appointment directly in the Portal may improve the overall experience as well.


She mentioned someone was suggesting an AEM form or Excel for intake and reporting, but she wasn't satisfied with that path. When discussing how this could be implemented leveraging SN, she was very interested in both the portal/form experience for citizens, as well as the case management workspace and workflow processing on the backend. She thought ServiceNow would be a powerful tool to house, process, and report on these requests, and confirmed that there would be no issue with having the 'small' team who would work these operate within the agent workspace. She also noted that the Office of Civil Rights￼


She'd like to set up a demo showcasing what this process and experience could look like in ServiceNow. At this time, she's waiting to learn more about what the next steps are out of litigation and mediation, but she is expecting MO DSS FSD needing to execute fairly quickly on the ask. ￼


Funding / Procurement: She noted that this could likely be expedited as an 'emergency' since this is tied to litigation.




A quick search yielded similar requests:

- https://mn.gov/mmb-stat/equal-opportunity/ada/accommodation-request-form.pdf

- https://www.nyc.gov/assets/hra/downloads/pdf/services/ada_forms/HRA-102c(E).pdf







Spoke with Kim Evans on 10/16/24. Kim very much was appreciative of the Phase 1+2 efforts and sees Servos as 'her vendor' for ServiceNow and FSD Benefits Portal work. Her words: "The work on the FSD Benefits Portal is not done."

---

# DSS Notes
(Last modified: 2025-02-04T21:59:23Z)

DSS Notes

---

# New Leadership recommendations
(Last modified: 2025-05-29T14:30:18Z)

New Leadership recommendations









05/15/25 - ServiceNow/Servos/DSS


Attendees:


Will Loving


Lauren Sparks


Paul Kilgore


Darris Adkins


Doug Bagley


Toi Wilde


Mandy Adams


Joan Rogers – Deputy Director


Stephanie Netwon


Heike Johns - Director




Agenda:


- Introduction 

- Overview of Platform

- WY Permits overview

- Where to start

- Next steps 





Notes


- BRMs have the overview on the QVL – we are getting more of a preview than the state on the QVL. BRMs will be attending with the vendors

- MME – hoping to have it wrapped up by the end of the summer – should be coming relatively soon – that's a big one

- 
Servos Overview


- Been working with Big Deloitte firms + Accenture firms

- Pretty close to the funding source with specific SN implementations and think that's on safe place

- Looking at implementors and the right

- 
Did Liz reach out to Paul? Liz? Discuss that - (HTE) + the work in 


- Several Case Management Solutions

- It's important we can get the right vendors in 

- Social Services side in this and implementing base 

- Really good implementer … know the ones to avoid and it's a very small ecosystem and trying to build those strong partnerhsips

- BPR – reconceptualizing – there was sometimes the funding sources weren't available and ensuring we are cognizant and aware of + timeliy implementations + resource stacking

- Mandy would be really critical in this and ensuring we pick really good use cases and do a good job of scoping out with the fixed budget to show

- PRM + Implementer +

- Strategic for the implementation services – really relying on our implementor




- 
Anthony:


- Demand Expertise and Experience

- Partner closely with Mandy as we pick the use cases, the business folks have the capacity to do that project

- Medicaid/SNAP reduction – align use cases well and resources and ensure there's the right tech stack




- 
Use Case: Whiteboarding sessions with ServiceNow staff and get our use cases clear


- Want to keep the implementation use case more high-level

- Think we will have more flexibility with the SN platform, but if we wouldn’t be interacting with them as much in this project, these could be run a bit more agile and need to make sure Mandy is prepared for requirements for Staff time

- If we have a project plan or sprints, then we can align to that




- 
Ensuring the BPRM, OCM, Project Management – ensuring a well-rounded contract


- We are comfortable with partnering with other vendors




- Get a run on the use cases to determine what is a good fit or not – here are our needs and the menu to see what is the best fit




- DSS Priorities and Goals – What do they want to get done

- 
Pilot with FSD - Communications


- Making sure we have a good place to keep information – but really to have a hub for all types of information exchanged for folks to go to, submit anonymous

- Trialing with FSD but Houston seems to have more use cases




- 
Legal Case Management System for Legal


- They have a lot of wishes and have those wishes articulated

- 
They have a DB that shuts down 3-4 times a day


- Doug can introduce to TN for HHS legal case management + if they are permissible to see a demonstration

- Administrative hearings on the benefits side, litigation on child support, document management, redaction

- It would be good to have a state perspective – it's great but you can't sole source. They have seen what they want – in general no matter what route we go, need to competitively procure. They are reasonable and would be open to see if another state is using and hat that looks like.

- They requested a budget line item for this – the budget that they have won't procure off of an RFP

- SN is already an app that we don't have to pay for, then can take their budget and kick-in a bit more to pay for the implementation and then ask more in their line item for enhancements

- They had an RFP they pulled back, then get an RFI – trying to find them something that is suitable and will meet needs

- ACTION: Doug to coordinate with Darris on this front to make the connections happen.

- ACTION: To determine LSD Use Case Fit




- Does an RFI allow you to procure? Would give me a good budget and would help me talk with Legal Services through configuration vs. Customization. They are very willing to start with a base of anything.

- Joanie: on the plus side, it wouldn’t take much to impress them




- Use Case: Business Process Re-Engineering > Look at the business processes and where the technology stack today and identify your issues

- 
Ie: Case management system and BPR – the way you do waitlists today – there's no off the shelf solution. The role-based access, then you need to think about that – a whole lot different level of BPR 


- What HVTech did – here is current state and looked for efficiencies – Terry director over is very open to changing

- Don't think it'd be that hard across the board to change what they are doing




- Use Cases: Current and Moving out of That

- Use Cases: Scheduling – know SN has a scheduling module and for the foster parent interaction piece

- Doing a demo or a test with community partners + participants to come in and test this – what better way to get the word out

- Provider portal







Other notes:


- Toi has $4M budgeted for this work and will be directing it to Servos and HealthTech Solutions

- DSS Communications project still in the works - wondering if ServiceNow is a fit - more of a community/comms use case - Houston is still the person leading

- Recommended we contact Richard Kliethermes at DMH for potential SN project



----------------------------------------------------------------------------




Scheduling meeting with new leadership in DSS:


- Jessica Bax - Director

- Joanie Rogers - Dep Director (not new but new role)

- Toi Wilde - CIO of DSS - new position

- Sara Smith - Director of Childrens Division











Not fond of approach and past leadership was taking - solving point solutions instead of wholistic




Never built anything to schedule appointments, just to check appointments - using API




Should address items more strategically than reactive - example - MyBenefits Overview - integrates with MEDES? - grabs whatever MEDES has - is it digestible and easy to understand? Prob not - we didn’t have the time/$$ to capture data and display in an appropriate way.




Type of work Kim was prioritizing for us was mostly to keep other teams from changing focus or time (MEDES team, etc.)




Kim wouldn’t allow us to even send the Renewal data via API into the eligibility system - we could have easily - instead it was to create a PDF and put in FileNet




Focused on CMS compliance vs. better for the citizen




MEDES, Redmane and eSystems work and backlog was prioritized versus ServiceNow enhancements

---

# [int] Servos MO Account Check-Ins
(Last modified: 2026-01-14T16:52:25Z)

[int] Servos MO Account Check-Ins








Date | 
Attendees | 
Notes | 





| 


| 


| 



01.14.26 | 


| 


| 





| 


| 


| 



01.14.26 | 


| 

Paul's Departure


- Renee texted Lauren indicating Paul was let go







DSS


- 
Onsite 01/14 + 01/15


- Andy Berg, Shea M, Chris C, Andy Martin [Rick Taylor?], Sean Keller




- 
ID.me


- Logan is going to be onsite in MO for meetings on Thursday

- ACT: Follow up with Logan on how these went




- 
PMO QVL SOW has not come out for HealthTech yet


- Will hasn't talked with Liz before the holidays




- ACT: Will / Matt to reach out to to Paul K and determine next steps





DNR


- Reach back out with a check-in with 





DESE


- Barb is working on that QVL submission for SEBT





DHEWD – Dept of Higher Education and Workforce Development


- Renee mentioned that they will be going through the QVL for a Grants Management Solution




| 




09.18.25



| 
| 

Two Story Meeting with MO


- Doug Bagley introduced – Apirio Solutions

- Spinout company – use AI to help people managers identify potential flight risks + help companies retain employees

- 
Department of Corrections – problem with turnover


- Feel like they have been working to test things out and do POC sort of work




- Two Story is recommending trying to implement it in ServiceNow

- Next Call would be to see a demo





DESE SEBT – Barb


- Good call – they want to do a bunch

- A lot was resetting expectations with folks who weren't there the last time

- 
Document that was produced – SEBT Recommendations


- Talked through those workshops, what the outputs were

- Got them up to speed on the last solution, gaps, and challenges

- Sent them the docs to have them review, then wanted them to come back for a future state solution




- 
Wanted to spend 200k through June 2026


- Plan on this is to go through Carahsoft / Naspo / Valuepoint

- First project was first used for licensing




- 
DESE – New person from DESE mentioned that they haven't seen anything


- Barb was quick to say it was a stop-gap solution 

- Sort of worked, nothing to model – moved it to the new instance when they shut down the DESE instance

- Hasn't been looked on or turned

- MO Enterprise Instance – would be the target




- 
They were looking for big improvement from what they are doing today


- The ask was similar because that's what she had heard was available before

- Did what they could with the time that they have, but wouldn't rebuild – onsite for a workshop as well




- 
Next Steps:


- Using the document as the jump off point – what do they want

- 
Give them a week or so and then follow up at the end of this week with the team


- Would be a scoping discussion and to do a workshop - 




- 
Before the call, David had looked at the deliverables – next call would be to be in person to validate the desired future state


- Integration to MOSIS – as a potential need











ID.me


- 
Meeting got pushed and he listened in: Accenture, Google, and a few others were there


- Accenture didn't speak but they believe their play is connecting the chatbot to Google over there – no other info








DSS + Liz Conversations on ND CCWIS


-----------------------------


Conversation with Paul


- 
Still working on the renewals and in the same deal cycle the last 3-4 months – December 4th


- Was trying to accelerate the renewal, any indications on what that renewal looks like

- Think some FSM will show up for Toi

- Trying to get ITSD to do something besides their compliance

- 
When they contracted with SN originally – do UU for the consolidated agencies – all the state employees are hitting and are out of compliance. 


- Have some true-up and outside of that trying to get AI and SAM in there for what's in the balance




- Looking at an enterprise AI SKU to give them AI wherever there is a Pro SKU




- 
If Paul had a new deal for renewals – should we put in a deal reg on our side? To get an influence


- Paul – yeah that's up to us – don't even know there's a limit up to that




- 
DSS Updates


- 
Keeping in touch with HealthTec – Liz Linville – RFO for Program Management + Business Process


- Any day now and we are monitoring




- 
Accenture / Google IVR Chatbot stuff is underway – heard anything on this


- Thought this was already built a while ago and heard they are working on that

- Expect Toi to leverage SN at somepoint to help use the work




- Citizen Engagement for Case Workers

- Income Maintenance Worker Requirement

- 
Believe in the course of doing work – she's tapped Accenture for the business processes of the current state mapping of this


- Darris was editing them in real time

- Sounds like somewhere along the way – she's contracted with Accenture to help them with some of that stuff to get scopes around what they are requesting

- If they are identifying the processes – what they will do there too.




- 
CD – CCWIS – HealthTec did win the aware for the CCWIS Planning and RFP writing for MO


- $2.4M - the APDs

- Is this still anchored by Toi – as the CIO of the department

- Need a significant CCWIS or other large platform with DSS

- Planning, Writing, Running RFP, sticking around for OCM as part of the implementation







- 
Stephanie – Center of Excellence


- Bring some of the resources in for training

- Renee's team with governance







| 



09.18.25 | 


| 

ISM and Toi – Logan got Connected with Toi


- ID.ME with income verification and the steadyIQ

- 
ID.me will be the citizenship verification 


- LN can't do or doesn't do well




- Liz Linville from HealthTech was there

- 
Kemper – Health Information Exchange


- Do work in MO + KY

- LACY Lewis and Clark Information Exchange (LACIE)




- 
From Toi


- Still working through the procurement stuff

- 
Going to get the PMO vendor (HealthTech) engaged first


- Talked about Roadmap + not sure if it makes sense to go and build now – get together and brainstorm on what we know what would be a sequence

- Put something down – don't think us pitching to meet with Toi to walk through a roadmap – sounds like they are already doing that




- 
What we pitched was, we need to be a part + can help inform the processes + what is OOTB 


- Looking at it more broadly across the platforms




- 
CCWIS – she mentioned that there's an RFP out to engage the planning vendor and we are not going to respond to


- She's getting that going to get it off their plate

- Ignoring the children's division items 




- 
Foster Parent Portal – talking about these two things together 


- Not a separate – going to use Benti + NASPO through carasoft for licensing

- Supposed to be CCWIS but they are not







- 
Carole Hussey – caught up with her the next day


- MO Human Services Group (HSG) - persona non grata in Missouri – may not make sense to partner with them on MO moving forward

- Binti – Clark CO Nevada has implemented Binti and it's been a disaster




- 
Liz Linville


- Hung out with her both nights + met with her last day

- A lot more open and transparent + have had people on the bench thinking this would start in July

- Wants us to be involved in the initial engagement + asked if we were partnered with someone else

- Inferred that we've been talking to other partners in Missouri

- Position hasn't changed – it was a good conversation and a handshake conversation – think we'll be great to work with

- Set up a call in a few weeks once she has more visibility

- SOW for that first wave is in the work right now

- Brought up the rates – had never talked rates + have never billed on those rates before

- QVL vendors + created of their docs + partner portal + certifications + not a Servos document – thinking about sending this to Liz

- Wanted to tell her that too to set the expectation

- Value in bringing us into the planning efforts




- 
Logan


- Paula Peters is retiring – she's staying on a little longer – gave her a salary bump to stay around for a few more years 

- 
Jason Comer – he is going to be Toi's right hand person


- Logan didn't like because [way back] he was the one pushing against SN as the platform back




- Accenture and Google are in there doing this IVR that is supposed to fix some of the call volume problems

- 
Have been using Genesys – replacement or a supplement for now to help address the status of their applications


- 50% of the call volume







- 
Engage with the contract


- Get together with the vendors to have the planning discussion

- 
Logan – pushing with Toi and to be very clear what lines these work in + even get a call with Liz, Us, and Toi – get something up to connect


- Ping liz and get something on the calendar in a few weeks








| 



05.13.25 | 

Lauren


Will


Megan M


Pat



| 

Bi-Weekly MO Account Touchbase


- 
Budget Review / Analysis: Missouri FY2026 Grok.docx | Missouri FY2026.docx


- $50M for implementation for YoY

- Looking for the report on the budget and where things have landed and the funding




- Ongoing RFPs / PAQs / SOWs

- 
Strategy / Meetings / Relationship Building


- 
DNR conversations – let's send a follow up email and the next steps were for them to do a reverse demo and get an understanding of scope and the next steps there


- Functions prior to the QVL

- BRM? > who is this and how would they would engage moving forward




- 
OA-ITSD


- Keep an eye out for ITSM for RFP / QVL




- 
DSS


- 
Legal Case Management – Toi follow up + may want ServiceNow to do that


- Pending Toi's confirmation and next steps

- Richard in HHS TN is our customer and we could reach out to him for HHS to understand what they are using it for.




- 
Grievances – Next Steps?


- Review email and follow up appropriately for next steps on this one




- Citizen Engagement Portal










| 



05.13.25 | 

Lauren


Will


Megan M


Pat



| 

Bi-Weekly MO Account Touchbase


- $50M for implementation for YoY

- Looking for the report on the budget and where things have landed and the funding

- That's not a bad situation so long as they will take that role and they are advocates





Greg + Craig + intro with new CIO Corey Mock


A bunch of folks on the infrastructure side

| 



02.18.25 | 

Lauren


Will


Megan M


Pat



| 

Bi-Weekly MO Account Touchbase


- Issue more from the top

- 
Call with Winton + Paul the other day – last Thursday + Check-In


- focus of the discussion was they were caught with their pants down because they haven't made the progress just from John Laurent + OA in general

- That's what they are struggling with – how to ask when they don't have progress to show

- Launched into it with Winton with what we have seen – no one driving this effort

- 
CCWIS is in process – don't worry about CCWIS


- 
No active work going on to put out a CCWIS RFP


- New Directors + change over + everything has stopped







- 
Joanie Rogers will likely run the CCWIS procurement or effort when it comes up


- 
CD Director – Sarah Smith


- Interim Kayla




- DSS Director – Jessica Bax




- Pushing to get the RFPs to go out to look at the Enterprise Agreements they already own (to try to drive the adoption of ServiceNow)

- 
Citizen Portal


- 
Need ammunition to go to John + Ken Zellers to go and say you need to clear the way


- Procurement

- Priorities

- Citizen Portal Ownership




- Will threw the PMO under the bus – PMO makes it more complicated than it should be




- 
Next Steps:


- Legislation is in session – new junior state senator in the appropriations committee want to give this information to and push the citizen portal 

- Use cases on the portal + how it was left







- 
Sent to Paul


- Summary of case studies of something to arm Winton with of other use cases in the states




- 
Their citizen portal 


- 












- DSS FSD – Kim Evans is on Thin Ice and might be retiring early or asking to leave





Follow Up


- Leave the building + helping – don't want to and how do we get back in


| 



02.04.25 | 

Lauren


Will


Megan M


Pat

| 

Bi-Weekly MO Account Touchbase




Follow Up


- Follow up with Renee

- 
Follow up with Timmons Group – Check in on PAQs


- Not sure on that process with procurement - 

- How is the PMO working with the BRM

- We heard from the ServiceNow team that DMH might be something - 

- 














ACTION: Curate topics for 


- DSS: Email to Stephanie and Amanda Grey

- DESE follow up with Barb - 

- Edward new platform owner – get on his radar

- Cindy Hassler





CCWIS and Next Steps - 


- Meeting on Thursday with the ServiceNow Professional Services

- 
ServiceNow Professional Services / Expert Services


- For the last few years, have 2 sales for all of the US

- They have hired or moved people around for SN – now have 4-5 sales 

- Jason Sweat introduced Aaron Marx

- Partnering with Professional Services is a Pain – for this CCWIS effort – to get them onboard as seeing SN as the platform for CCWIS it will be better for them holding the bag

- This should be the strategy to determine who we should partner with

- 
He is going to be the guy to talk through this and what that looks like


- This call will be to introduce ourselves and what we are doing + mention other states so he knows what we are doing







- 
MO Account Team


- Darris, Chris Dilley + all those other folks




- 
Feel better about our ability


- 
If we can get a meeting with Amanda Grey and Stephanie Newton


- Introduce Servos

- Talk about the work we've done

- 
Understand the priorities as they have been evolving


- Medicaid

- CCWIS







- Joanie is busy and pushed it off to them – need to connect with them to figure out some next steps

- Press on Paul + David to see they have the line in directly 




- 
Pursue the ones that we have


- What gets out of session and what passes








Potential Onsite


- 
GovTech is coming up – not until June


- Can check with the ID.me people to see what their sponsorship level and maybe it's' one we can ride along as a pass

- One of the things is there's all of these conferences + items




- 
Better would be to figure out a time onsite and setting up some meetings – when would be a good time + tee up CCWIS + demo in person


- A couple days, set up meetings with as much as we know




- Logan is the ID.me side – will see if he does it with the State of with the Agencies





Web Resources for Missouri


- Kind of have to hone it down into what you are looking for

- Pat to send – I will look – then will take a peek at these




| 





| 


| 


| 





| 


| 


| 



09.13.24 | 

Lauren


Ruthie

| 


Discuss SD SDLC with Ruthie


General Overview


BIT – beauro of information and telecommunication


- Each vertical has a BRM who liason with the agencies in the vertical



Enterprise team for SN

- 
Portfolio Manager – Bridget – Oversees SN Program


- Day to day she is the closet to the person who fields demands, determines if SN is a good fit, staffs the teams and makes the projects




- Alana – Platform Upgrades & Bug Tickets

- 
All SN developers are on this team


- 






- 
One Team – DOLIR, has own SN team and these are the strongest SN developers; still BIT employees but still FT to the agency


- Other agencies want to go that way & Fully dedicated to SN and one agency – just a couple of apps they are really good at. have one stakeholder and a tighter operation

- COE Teams Channel to allow for open questions and comms





Challenge is the New Silos and Feeling like it's not part of the process

- Govenor has decreed it would be in SN


BIT Enterprise – Platform Architect and a lead developer and took to SN the best when they were doing their training

- Responsible for the code reviews and the overall platform governance

- 
Gate keeper for the clones and the promotions to PROD


- Lead developer is a full time SN person




- Continue upskilling in their code reviews




How SD SDLC Works in SN

- 
Use PPM for their demands, but don't run their projects out of SN


- 
Tickets are in ADO and manage user stories and work out of that


- Ticket work...don't think there's an SA

- Developer gets the ticket, does the investigation, proposes a fix, tests it, 




- 
2 releases a month


- 
Major Release monthly


- Larger project go-lives

- Regression test after every release




- Minor Release for smaller items

- 
Upgrades every 6 months


- Learning from each release

- Do some ATF to facilitate regression testing

- Putting together training guides on how to test

- Playbook with every upgrade & beefing up their documentation

- 
OCM & project planning – product owners, project managers, service owners


- Would have been nice to do OCM up front to prepare the agencies that they should do this every 6 months




- 3-4 weeks for an upgrade cycle











The Good / The Bad



Changed how they are organized – industry verticals to help support specific agencies that 





| 



07.31.24 | 

Lauren


Will


Pat


Matt

| 

State of Missouri Strategy


Doing this with the 5 Key Accounts


Govenor's Office Standpoint & Budget Standpoint


Ton of information at the tactical level and the certain things we are hearing and seeing


Finding other opportunities that we are not aware of


A better lay of the land more than all accounts


MISSOURI HAS MONEY – Took longer to see what happened that caused the pause in some of these projects.


MO is kind of like TN, as far as populations


- Cut the budget by 3% - pretty big number

- There are funds set aside for these specific things...some of the areas we play in may take some



Strategy > Agencies


- 
Taking our permitting and licensing solution


- PLB > maybe not here

- Parks 




- Vocational Rehabilitation Connection

- DESE NDI

- 
Conversation through David Winton with DSS


- Foster Parent Portal – Pre CCWIS RFP

- 
BRM – seems like IT gets in the way


- Good reasons or no real reason and slows things down

- Don't know if we can leverage Pat with Paula Peters

- How do we help enable this stuff and who is your delegate > Dan and Tom







- 
Introduction with Pat and Paula


- Try to get a meet and greet on the calendar + might lead to something else and leads to conversation

- Pat is happy to reach out to direct as well







| 



05.22.23 | 

Lauren


Will


Matt


Ryan


Bobby

| 

DSS FSD Benefits Portal


DSS Foster Care / CWISS


ITSD Platform Support Contract


- There was a presentation by the CTO of MT – the K23 presentation is great. The recording is out there and Will chatted with Stephanie about it briefly

- Talked about governance JUST on ServiceNow, and it's pretty much what MO should do and laid out in a prescriptive and simplified manner. Could help them drive and be a part of it.

- She noted there will be other vendors working in the state – they need to do it but not have a vendor do it

- Will to follow up with Stephanie re: governance



DESE Grants Management


- Prioritize the focus here

- DESE grants SOW – how do we thread the needle



DESE Educator Certification


- Need a quick discussion with Ashley to ensure we are ready to go for tomorrow

- Should be more of an architecture discussion, may want to have Joe K in that call too. She could make that determination.

- ACTION: Thread with Ashley for the Meeting



Amusement Demo Last Week


- Trying to figure this out



Financial Management Use Case – going to say no, not a good fit 

| 



04.17.23 | 

Lauren


Will

| 

Pre-Sales


- 
Dept. Of Labor – will talk about the work in SD, and talk about their needs


- BRM for Labor – John Ferrier




- Tacket – Economic Development & Grants





Sales Team Notebook – MO tab or Folder – Created these things and put in pipe-draft


Servos Sales Team – Will to add me



| 



04.03.23 | 

Lauren


Will


Matt


David

| 

DSS Overview:


- Just so many dependencies

- Scoping for Phase 2 – discussion for Friday



Meetings to Schedule:


- Stuart? DESE folks?

- Kenneth??



Onsite this week


- Sent notes to John L, Jeff W, Stephanie

- Hey would love to meet briefly and hear vision and thoughts – share some findings and recommendations. Leaving it as a 2-way

- EA – Dan M.

- Renee > get sometime with Steph too – in Renee's ear



Logistics


- 
Won't get to St. Louis here until 11:30/11 CST


- Uber to Spirit of St. Louis Airport > Will can share the address and information

- Private FBO to check in and emails – pull up and jump in to JC and will be a 20 min flight.

- Get to JC by noon – airport is right there




- 
Fixed Base Operators (FBOs) 


- Lobby with seating and coffee

- Ramp with no security. Pretty efficient




- Working on Slides for Friday AM – Working with David on how to show some stuff – workflow and agent workspace



Governance


DESE


- Will will check with Stuart this AM

- They did receive our draft SOW and WBS for the first phase

- Send them a note to both




| 



03.06.23 | 

Lauren


Will


Matt


David

| 

PROJECTS IN FLIGHT


- 
Core Configuration – Renee


- A few items 

- 






- DSS IM Portal

- ACTION: Lauren to follow up with Renee and ask about the Transformational Project

- 









PIPELINE


- 
DESE Grants Management


- Chief Data Officer DESE

- Demo was long – provided good feedback

- David is going to speak more to functionality on the demo

- Stuart putting together the project Charter and will be that trigger

- SOW is not yet broken out with a Discovery phase and the rest

- Lauren to reach out and ask for the recording

- 
Stuart wants to see the WBS breakdown and the plan


- Lauren to start to review

- Layer – CM hours / Program Manager / Client Success Oversight







- Foster Parent Portal Support

- 
Platform Governance, Training, OCM


- We'll never going to see that








Paul Kilgore wants to know who to talk to about DSS and OKTA usage

| 



01.04.23 | 


| 


Notes from Jefferson City visit (Ashley/Jenni/Will) on 11-08-2022


- Office of Administration - is where Information Technology reports

- 14 Executive Agencies that are supported by IT - other agencies can do their own thing if they want (Public Safety, Sec of State, Judicial)

- Ken Zellers is Commissioner/COO of the State - reports to Governor who is a lame duck/lame governor - Ken really runs everything - was an exec at Anheiser-Busch

- Jeff Wann is the CIO - very cost-conscious and no one respects him

- Paula Peters - Deputy CIO - reports to Jeff but is actually running IT. But it was just announced that she is the Division Director of a new organization focused on Digital Modernization across the State - 2 main projects - Citizen Portal and ERP replacement projects - not sure of reporting, but maybe directly to Commissioner Zellers. Paula is very aware of Servos from Pat Snow talking us up to her at NASCIO

- Jeff Laurent - Dir of Enterprise Applications - respected and used to work at Accenture



Discussion with Ian Hilton and Michael Gallagher of WWT

- 
WWT Organization


- Ian Hilton - SLED - mostly MO but also other states

- Josh Skip - SLED AE in Michigan

- Jason Trego - SLED NYC - some work going on in NYC - Dan Scheel is pushing to do SN work in NYC - maybe we should connect with him on this

- Jason - SLED AE - CA, HI, WA, NY

- LaDonna Boyer - Overall WWT SLED Services lead - based in St Louis

- Phil Palmer - ServiceNow practice lead - Travis Toulson knows him and did some work with WWT in the past if we want to ask him




- WWT has strong relationships in OA (Office of Admin) IT

- Michael Gallagher used to run the St Louis Accenture office and built a large business in MO (among other things)

- MO just selected Oracle Cloud as their new ERP and Accenture is starting implementation ($100M project) - WWT is doing some of the work

- WWT would like to partner with us and are on specific MO state contracts for services - the other vendors on the contracts are Deloitte and Accenture. They will want to mark up our rates 20-30% but if they can have a few roles on the projects, that will help offset the markup.

- 
WWT knew of potential SN opportunities in these agencies:


- 
Secretary of State office - Stacy


- Opportunities with Library, Elections and Grants Management




- DESE - Margie Van Deven is Director, Pam Thomas - new Dir for Office of Childcare and Teresa Kelly is another key person

- 
Dept of Labor and Regulation - Anna Hugh Director


- TCS has been in there speaking with them about UI

- Division of Economic Security - has a new director as of 11/7/22

- TCS implemented UI Interact - their custom built UI system and talking about modernizing it




- 
DMV


- Big modernization project underway - considering FAST vs. Salesforce - may be an opportunity for SN - but SF could still win out




- 
Public Safety


- Sandy Carson is lead

- Not an exec agency so not under IT control

- Leverage our FL Disaster Recovery story - Ian Hilton can set up a meeting




- Regulation - MO just legalized Marijuana - Accenture built the medicinal system - but now recreational is allowed - could be an opportunity

- 
DHSS (equivalent of HHS) - Health and Senior Services


- Paula Nicholson is overall director

- Lydall Franker is also a director




- 
City of St Louis - Simon Huang is the CTO and his daughter works for WWT


- $1B in ARPA money and NFL Lawsuit money

- Opportunity for 311 Portal







- Big initiative by OA IT for Citizen One Stop - Statewide Portal - will likely be an RFQ or Quote request, but NOT AN RFP - we will need to partner with someone to go after it - will be up against Accenture and Deloitte - so we will need to go with WWT likely

- 
MO OA IT has standardized on a set of Enterprise Platforms/Standards


- ServiceNow

- Mulesoft (Integration platform)

- OKTA (SSO/Auth)

- OnBase (Doc Mgmt)

- K2 Intex - RPA

- Adobe Experience Manager (AEM) - eSignature

- AWS - Data Lakes

- Oracle Cloud ERP




- WWT introduced us to the COO of the State (Commissioner) - Ken Zellers in the Capitol - brief meeting and WWT introduced us as their go-to ServiceNow partner. We also met the guy who is the new head of Facilities that reports to Ken (Ask Ian for his name) - could be an Asset Management opportunity and FSM

- WWT introduced us to Paula Peters - Deputy CIO reporting to Jeff Wann (CIO)




Meeting with Erin Lepper (Business Relationship Manager for MO DSS):

- Erin suggested we connect with Angela Anderson - DESE BRM

- Medicaid project has been formally approved but we should consider subcontracting to SHI or WWT for the future since Procurement is claiming they can't use Carahsoft NASPO ValuePoint for services alone - must also include licensing - not sure if this is true

- Mulesoft has been selected for statewide integration platform, but not implemented yet

- OKTA is not implemented yet, but is in process and focused on internal use first

- MyDSS current portal uses DCN, SSN or Birthdate as identifying data element

- DSS is using HyperScience as an AI tool for handwriting recognition - moving from another tool they were using - could be an opportunity to look at SN Doc Intelligence

- Currently using Sharepoint and MEDES-Curem accessing FileNet for the content engine repository on a DB2 database with Tableau for reporting

- Genesys was going to be the appointment scheduler but it has been delayed





Missouri Background Info:



|

---

# General Info
(Last modified: 2025-05-16T19:29:15Z)

General Info







Key Players:




Ken Zellers - COO of State - Commissioner


Paula Peters - Dir in charge of transformation and ERP


John Laurent - Interim CIO


Stephanie Brooks - Chief of Enterprise Applications


Renee Wright - ITSD - to lead Citizen Portal project


Garrett Miller - Deputy Enterprise Architect


Dan Hlavac - Chief Enterprise Architect (contractor)


Steven Tackett - Natl Guard, Public Safety and DED


Brian Barbour - AppDev mgr DPS, Natl Guard DED


Dale Clack - DSHSS overall dev manager




ITSD Business Relationship Managers (BRM):


- Sarah Kent - DSS

- Steve Tackett - Fire Safety, Economic Development, Veterans Affairs

- Angela (Angie) Anderson - DESE, DHEWD

- Cindy Hassler - DMH - Cynthia.hassler@oa.mo.gov - (573) 526-7744

- Kimarley Mowatt - DCI





Procurement:


- Angela Sutton - Procurement

- Tara Dampf - Finance/procurement





Dept of Social Services:


- Kim Evans - Director FSD

- Liane Venderveld - Kim Evans Assistant - Liane.Vanderveld@dss.mo.gov

- John Ginwright - FSD Child Support





Other notes:


- Veracity IT did a project in MO by repurposing a USDA Grain Management system on SN











ServiceNow Impact:


- Kicking off engagement on October 12, 2023

- 
Potential team members:


- Kelsey Cleeves - account lead for Impact in MO


Linda Law


Mark Stonache


John Shores


















-----------


Renee conversation (04-17-2024) - with Lauren


- WWT doing UX design work - designs were underwhelming to Renee

- Feels like it's going to take a while to move forward

- State is going to look at Organizational Functionality

- May hire an outside firm for what sort of taxonomy and content to have on the portal

- Renee's role is getting more solidified as "portal development manager" - now that her team is forming - Tom, Dan and Mark on the ones driving the strategy. Tom owns the operational side of the platform.

- Big Takeaway - get with Paul and Doug when they get back from HI - who do we talk to about strategy and where they want to go with the portal

- Drupal has been a big discussion at the state for content management - state keeps getting stuck on how to do CMS

- Renee is telling people to go to Servos through Timmons via PAQ/QVL

- Dee and Alicia - still upset with Servos on DESE Grants - Renee was apologizing for how we were treated by them

- Salesforce is coming back at the state - pushing the platform

- Election year - things stay quiet through the end of the year

- Angie Anderson - had an idea to get all agencies to build a Citizen Complaint form in SN - then the data each agency would have interesting data and dashboards to review and show the Gov office

- Stephanie is not going to be involved in the platform as much moving forward - it's Tom Sholes, with support Dan and Mark







Missouri Info:


- 
DSS


- Lauren talking to Kim Evans about a Usability opportunity - but in depositions on things now

- DSS also has a need for a communications platform - connected Lauren with a new person - call next week

- CCWIS - co-sell with ServiceNow PS

---

# MO History Markdown
(Last modified: 2026-04-02T13:26:09Z)

MO History Markdown







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


|Tara Dampf| Deputy CIO| was procurement, a stickler for contracts and a blocker in most cases


|Paula Peters | Director of Modernization Office |is the real operator. |


| John Laurent | CIO → Dir of Enterprise Apps | Former Accenture. Respected. Stephanie Brooks took his old position. |


| Stephanie Brooks | Head of Enterprise Apps | Connected with Jeff Clines. Met for breakfast during April 2023 Jeff City trip. |




### DSS / Family Support Division (FSD)


| Name | Title | Notes |


|------|-------|-------|


| Toi Wilde | CIO of DSS | Driving the Constituent Engagement Casework Engagement modernization project | big ally of Servos and ServiceNow


| John Ginwright | Deputy Director, FSD Child Support & Enforcement | Oversees Child Support area. |


| Angela Terry | Child Support Systems Unit | Technical contact for CS systems. |


| Valerie Taylor | Region 2 Field Operations | |


| Director Jessica Bax | DSS Secretary/Director | Supports common portal vision. |




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


| Latoi Works | WWT Global Partner Coordinator | Latoi.Works@wwt.com — 314.919.1445 |




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


  │   ├── Income Maintenance (Medicaid/SNAP)


  │   │   ├── MAGI system (expanded Medicaid)


  │   │   ├── FAMUS system (legacy)


  │   │   └── 57,000 renewals/month


  │   ├── Child Support & Enforcement — Deputy Dir: John Ginwright


  │   │   └── 550 state staff (everyone answers phones)


  │   ├── Rehabilitation Services (Service for the Blind)


  │   └── Work Programs / Workforce Development (smaller)


  ├── DESE (Education)


  │   └── Grants Management (ePeGS system)


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


**URL**:  https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fpr.mo.gov%2Fprofessions.asp&data=05%7C02%7Cwloving%40servos.io%7C1cf40b4f25f44b15895f08de90ba8d75%7C12f2ee23457a4f1fa102db910fc3f866%7C0%7C0%7C639107328065324618%7CUnknown%7CTWFpbGZsb3d8eyJFbXB0eU1hcGkiOnRydWUsIlYiOiIwLjAuMDAwMCIsIlAiOiJXaW4zMiIsIkFOIjoiTWFpbCIsIldUIjoyfQ%3D%3D%7C0%7C%7C%7C&sdata=Htt4Q2OGT3uNO6zgikfWK1WQmXbq8SZnzXvxUwTdCwc%3D&reserved=0  


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

---

