import { getJobsFromR2, saveJobsToR2, ScrapedJob } from './r2-jobs-store';
import { findCompanyWebsite, scrapeCompanyContacts } from './jobs-scraper-service';
import nodemailer from 'nodemailer';
import { resolve } from 'path';
import * as fs from 'fs';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

let isApplyLoopRunning = false;
let getWASocket: () => any = () => null;

const STACK_KEYWORDS = [
  { tag: 'golang', patterns: [/golang/i, /\bgo\b/i] },
  { tag: 'react', patterns: [/react/i, /reactjs/i] },
  { tag: 'nextjs', patterns: [/nextjs/i, /next\.js/i] },
  { tag: 'python', patterns: [/python/i] },
  { tag: 'fastapi', patterns: [/fastapi/i, /fast-api/i] },
  { tag: 'django', patterns: [/django/i] },
  { tag: 'laravel', patterns: [/laravel/i] },
  { tag: 'php', patterns: [/php/i] },
  { tag: 'mobile', patterns: [/mobile/i, /react-native/i, /reactnative/i, /expo/i, /flutter/i] },
  { tag: 'aws', patterns: [/aws/i, /amazon web services/i, /fargate/i] },
  { tag: 'nodejs', patterns: [/node/i, /nodejs/i, /express/i] },
  { tag: 'postgresql', patterns: [/postgres/i, /postgresql/i] },
  { tag: 'mongodb', patterns: [/mongo/i, /mongodb/i] },
  { tag: 'typescript', patterns: [/typescript/i, /\bts\b/i] },
  { tag: 'kubernetes', patterns: [/kubernetes/i, /k8s/i] },
  { tag: 'nestjs', patterns: [/nestjs/i, /nest\.js/i] },
  { tag: 'vue', patterns: [/vue/i, /vuejs/i] },
  { tag: 'angular', patterns: [/angular/i] },
];

function extractTags(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const tags: string[] = [];
  for (const item of STACK_KEYWORDS) {
    for (const pattern of item.patterns) {
      if (pattern.test(text)) {
        tags.push(item.tag);
        break;
      }
    }
  }
  return tags;
}

function getMailTransporter() {
  const { SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
  if (!SMTP_HOST || !EMAIL_USER || !EMAIL_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

function validateAndFormatPhoneNumber(phoneStr: string): string | null {
  const phoneNumber = parsePhoneNumberFromString(phoneStr, 'PK');
  if (phoneNumber && phoneNumber.isValid()) {
    const numberOnly = phoneNumber.format('E.164').replace('+', '');
    return `${numberOnly}@s.whatsapp.net`;
  }
  return null;
}

function generatePitchEmail(job: ScrapedJob, tags: string[]): string {
  const recipientName = "Hiring Team";
  const companyName = job.company !== "Unknown Company" ? job.company : "your team";

  let projectBullets = "";
  if (tags.includes('golang') || tags.includes('aws')) {
    projectBullets += `- **Golang Distributed Chat System / Bridge**: Architected a real-time chat bridging network deployed on AWS Fargate serverless containers with ALB, PostgreSQL, and Redis.\n`;
  }
  if (tags.includes('nextjs') || tags.includes('react') || tags.includes('stripe')) {
    projectBullets += `- **Vine LMS (vinelms.com)**: Built a dynamic LMS using Next.js, Node.js/Express, PostgreSQL, and TanStack Query, integrating Stripe Connect, Reader Pay, and Stripe Meter.\n`;
  }
  if (tags.includes('python') || tags.includes('fastapi') || tags.includes('scraping') || tags.includes('django')) {
    projectBullets += `- **Anti-Bot Google Search Scraper**: Built a robust bypass/scraping engine in Python (FastAPI) and React utilizing Puppeteer and SeleniumBase.\n`;
  }
  if (tags.includes('nestjs') || tags.includes('vue') || tags.includes('kubernetes')) {
    projectBullets += `- **Enterprise E-Commerce Dashboard**: Created an administration panel using Vue.js 3, Pinia, NestJS, and containerized deployment with Kubernetes (K8s).\n`;
  }
  if (tags.includes('mobile') || tags.includes('flutter') || tags.includes('react-native')) {
    projectBullets += `- **Cross-Platform Mobile Apps**: Designed and deployed client applications using React Native, Expo, and Flutter with Redux Toolkit.\n`;
  }

  if (!projectBullets) {
    projectBullets += `- **Vine LMS (vinelms.com)**: High-performance Next.js and Node.js LMS with PostgreSQL and Stripe Connect.\n`;
    projectBullets += `- **Golang Distributed Chat System**: Scalable messaging bridge using Go, WebSockets, Redis, and AWS Fargate.\n`;
  }

  return `Dear ${recipientName},

I am writing to express my strong interest in the ${job.title} position at ${companyName}. As a Senior Full-Stack Developer with 2+ years of hands-on experience building enterprise management systems, scaling backend architectures, and designing responsive frontends, I am confident I can add immediate value to your team.

My technical background aligns closely with the requirements outlined in your job description. Here are a few relevant projects I have delivered:

${projectBullets}
I pride myself on writing clean, maintainable code in TypeScript, Golang, and Python, containerizing services via Docker/Kubernetes, and setting up automated CI/CD pipelines via GitHub Actions.

I have attached my tailored resume (which outlines my detailed experiences with Woltrio and Swismax) for your review. I would love the opportunity to discuss how my skill set can support ${companyName}'s engineering goals.

Thank you for your time and consideration.

Best regards,

Talha Riaz
Islamabad, Pakistan
+92 318 585347
talhariaz5425869@gmail.com
GitHub: github.com/talhary
Portfolio: talhacodes.site
`;
}

export async function processDirectApplications() {
  if (isApplyLoopRunning) return;
  isApplyLoopRunning = true;
  console.log('[Direct Apply Service] Starting job application processing run...');

  try {
    const jobs = await getJobsFromR2();
    if (jobs.length === 0) {
      console.log('[Direct Apply Service] No jobs found in R2 database.');
      isApplyLoopRunning = false;
      return;
    }

    const transporter = getMailTransporter();
    const sock = getWASocket();

    if (!transporter && !sock) {
      console.warn('[Direct Apply Service] Skipping run: Both Nodemailer and WhatsApp clients are unavailable.');
      isApplyLoopRunning = false;
      return;
    }

    const cvPort = process.env.CV_GENERATOR_PORT || '8082';
    let dbUpdated = false;

    // Filter jobs that match our tech stack and have not been applied to yet
    const targetJobs = jobs.filter(j => {
      if (j.appliedAt) return false;
      const tags = extractTags(j.title, j.description);
      return tags.length > 0;
    });

    console.log(`[Direct Apply Service] Found ${targetJobs.length} matching jobs to check for application.`);

    // Rate Limiter: Max 5 applications per 30-minute run to prevent spam flagging
    const MAX_APPLICATIONS_PER_RUN = 5;
    let applicationsSent = 0;

    for (const job of targetJobs) {
      if (applicationsSent >= MAX_APPLICATIONS_PER_RUN) {
        console.log(`[Direct Apply Service] Hit application cap of ${MAX_APPLICATIONS_PER_RUN} for this run. Remaining jobs will be processed next run.`);
        break;
      }

      // 1. Resolve company website if missing
      if (!job.companyWebsite && job.company !== 'Unknown Company') {
        try {
          const website = await findCompanyWebsite(job.company);
          if (website) {
            job.companyWebsite = website;
            dbUpdated = true;
          }
        } catch (webErr) {
          console.error(`[Direct Apply Service] Error finding website for ${job.company}:`, webErr);
        }
      }

      // 2. Resolve contacts if missing
      if (job.companyWebsite && (!job.contacts || (!job.contacts.emails?.length && !job.contacts.phones?.length))) {
        try {
          const contacts = await scrapeCompanyContacts(job.companyWebsite, job.company);
          if (contacts) {
            job.contacts = contacts;
            dbUpdated = true;
          }
        } catch (contactErr) {
          console.error(`[Direct Apply Service] Error scraping contacts for ${job.company}:`, contactErr);
        }
      }

      let appliedSuccessfully = false;

      // 3. Attempt email application if email is available
      if (transporter && job.contacts?.emails && job.contacts.emails.length > 0) {
        const primaryEmail = job.contacts.emails[0];
        const tags = extractTags(job.title, job.description);
        console.log(`[Direct Apply Service] Applying to "${job.title}" at "${job.company}" via email "${primaryEmail}"...`);

        try {
          const cvResponse = await fetch(`http://localhost:${cvPort}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags }),
          });

          if (!cvResponse.ok) {
            throw new Error(`Go CV generator returned status ${cvResponse.status}: ${await cvResponse.text()}`);
          }

          const pdfBuffer = await cvResponse.arrayBuffer();
          const emailBody = generatePitchEmail(job, tags);

          await transporter.sendMail({
            from: `"Talha Riaz" <${process.env.SENDER_EMAIL || process.env.EMAIL_USER}>`,
            to: primaryEmail,
            subject: `Application for ${job.title} - Talha Riaz`,
            text: emailBody,
            attachments: [
              {
                filename: 'Talha_Riaz_Resume.pdf',
                content: Buffer.from(pdfBuffer),
              }
            ]
          });

          console.log(`[Direct Apply Service] Email sent successfully to ${primaryEmail}!`);
          job.appliedAt = new Date().toISOString();
          dbUpdated = true;
          appliedSuccessfully = true;
          applicationsSent++;

          // 10 second delay between applications
          await new Promise(r => setTimeout(r, 10000));
        } catch (appErr: any) {
          console.error(`[Direct Apply Service] Failed to send email to ${primaryEmail}:`, appErr.message);
        }
      }

      // 4. Attempt WhatsApp application if email failed/unavailable but phone number exists
      if (!appliedSuccessfully && sock && job.contacts?.phones && job.contacts.phones.length > 0) {
        const tags = extractTags(job.title, job.description);
        
        for (const phone of job.contacts.phones) {
          const formattedJid = validateAndFormatPhoneNumber(phone);
          if (!formattedJid) {
            console.log(`[Direct Apply Service] Invalid phone number format: "${phone}"`);
            continue;
          }

          console.log(`[Direct Apply Service] Checking if WhatsApp exists on "${formattedJid}" for "${job.company}"...`);
          try {
            const waCheck = await sock.onWhatsApp(formattedJid);
            const exists = waCheck && waCheck[0] && waCheck[0].exists;

            if (exists) {
              console.log(`[Direct Apply Service] WhatsApp contact exists! Preparing tailored CV and message...`);
              
              const cvResponse = await fetch(`http://localhost:${cvPort}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags }),
              });

              if (!cvResponse.ok) {
                throw new Error(`Go CV generator returned status ${cvResponse.status}`);
              }

              const pdfBuffer = await cvResponse.arrayBuffer();
              const messageBody = generatePitchEmail(job, tags);

              console.log(`[Direct Apply Service] Sending document + pitch via WhatsApp to ${formattedJid}...`);
              await sock.sendMessage(formattedJid, {
                document: Buffer.from(pdfBuffer),
                mimetype: 'application/pdf',
                fileName: 'Talha_Riaz_Resume.pdf',
                caption: messageBody
              });

              console.log(`[Direct Apply Service] WhatsApp application sent successfully to ${formattedJid}!`);
              job.appliedAt = new Date().toISOString();
              dbUpdated = true;
              appliedSuccessfully = true;
              applicationsSent++;

              // 10 second delay between applications
              await new Promise(r => setTimeout(r, 10000));
              break; // Applied successfully to this job, break phone loop
            } else {
              console.log(`[Direct Apply Service] Contact "${formattedJid}" is not registered on WhatsApp.`);
            }
          } catch (waErr: any) {
            console.error(`[Direct Apply Service] WhatsApp send error to ${formattedJid}:`, waErr.message);
          }
        }
      }
    }

    if (dbUpdated) {
      console.log('[Direct Apply Service] Saving updated jobs database with application states to R2...');
      await saveJobsToR2(jobs);
    }
  } catch (err) {
    console.error('[Direct Apply Service] Error during direct apply service run:', err);
  } finally {
    isApplyLoopRunning = false;
  }
}

export function startDirectApplyService(getSocket: () => any) {
  getWASocket = getSocket;
  console.log('[Direct Apply Service] Initializing Automated Direct Application Service...');
  
  // Run 1 minute after start to let rest of the servers boot up fully
  setTimeout(() => {
    processDirectApplications().catch(err => {
      console.error('[Direct Apply Service] Run error:', err);
    });
  }, 60000);

  // Periodically check/apply every 30 minutes
  setInterval(() => {
    processDirectApplications().catch(err => {
      console.error('[Direct Apply Service] Scheduled run error:', err);
    });
  }, 30 * 60 * 1000);
}
