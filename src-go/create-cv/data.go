package main

import (
	"strings"
)

type SummaryItem struct {
	Text string
	Tags []string
}

type WorkExperience struct {
	Company string
	Role    string
	Date    string
	Bullets []string
}

type DefaultBullet struct {
	Text string
	Tags []string
}

type DefaultWorkExperience struct {
	Company string
	Role    string
	Date    string
	Bullets []DefaultBullet
}

type Project struct {
	Title   string
	Bullets []string
	Tags    []string
}

type SkillItem struct {
	Name string
	Tags []string
}

type SkillCategory struct {
	Name  string
	Items []string
}

type DefaultSkillCategory struct {
	Name  string
	Items []SkillItem
}

type EducationItem struct {
	Degree string
	School string
	Date   string
}

type CVData struct {
	Name        string
	Role        string
	ContactInfo string
	Summary     string
	Experiences []WorkExperience
	Projects    []Project
	Skills      []SkillCategory
	Education   []EducationItem
	Languages   []string
}

type CVFilterRequest struct {
	GeneralTags    []string `json:"tags"`
	ProjectTags    []string `json:"project_tags"`
	SkillTags      []string `json:"skill_tags"`
	ExperienceTags []string `json:"experience_tags"`
	SummaryTags    []string `json:"summary_tags"`
}

// Default CV Data
var DefaultCV = CVData{
	Name:        "TALHA RIAZ",
	Role:        "SENIOR FULL-STACK DEVELOPER",
	ContactInfo: "Bhara Kahu, Islamabad, Pakistan | +92 318 585347 | talhariaz5425869@gmail.com | github.com/talhary | talhacodes.site",
	Education: []EducationItem{
		{
			Degree: "BS in Mathematics",
			School: "Quaid-e-Azam University, Islamabad",
			Date:   "2021 - 2024",
		},
	},
	Languages: []string{
		"English: Proficient",
		"Urdu: Native",
	},
}

var DefaultSummaryItems = []SummaryItem{
	{
		Text: "Senior Full-Stack Developer with 2 years of experience building enterprise-grade Management Systems.",
		Tags: []string{"all", "react", "nextjs", "golang", "python", "mobile", "vue", "angular"},
	},
	{
		Text: "Expert in Next.js, MERN stack, React Redux, and modern frontend frameworks including Vue.js and Angular.",
		Tags: []string{"react", "nextjs", "mern", "vue", "angular", "frontend"},
	},
	{
		Text: "Proficient in Python (FastAPI, Django), Golang, NestJS, and databases (PostgreSQL/SQL, MongoDB, Redis).",
		Tags: []string{"python", "golang", "fastapi", "django", "nestjs", "postgresql", "mongodb", "redis", "sql", "backend", "database"},
	},
	{
		Text: "Specialized in high-performance UIs using Tailwind CSS, GraphQL, and payment systems (Stripe Connect, Reader Pay, Meter).",
		Tags: []string{"tailwind", "graphql", "stripe", "frontend"},
	},
	{
		Text: "Robust data orchestration via Prisma, Drizzle ORM, and TanStack Query.",
		Tags: []string{"prisma", "drizzle", "react-query", "frontend", "nextjs", "react"},
	},
	{
		Text: "Architecting scalable backends and cloud infrastructures using Kubernetes (K8s), AWS Fargate, EC2, ALB, ACM, and Docker.",
		Tags: []string{"aws", "fargate", "ec2", "docker", "kubernetes", "k8s", "backend", "cloud", "devops"},
	},
	{
		Text: "Skilled in cross-platform mobile app development with React Native, Expo, and Flutter.",
		Tags: []string{"mobile", "react-native", "expo", "flutter"},
	},
	{
		Text: "Streamlined development workflows with GitHub Actions CI/CD and automated testing via Puppeteer/Selenium.",
		Tags: []string{"github-actions", "devops", "puppeteer", "selenium", "scraping"},
	},
}

var DefaultExperiences = []DefaultWorkExperience{
	{
		Company: "Woltrio",
		Role:    "Senior Software Engineer",
		Date:    "2025 - PRESENT",
		Bullets: []DefaultBullet{
			{
				Text: "Building modern healthcare frontends with TanStack Start, Angular, Vue.js, and shadcn/ui for premium user experiences.",
				Tags: []string{"react", "frontend", "nextjs", "tailwind", "shadcn", "angular", "vue"},
			},
			{
				Text: "Implementing complex server-state management using TanStack Query (React Query) and Redux Toolkit with Prisma and Drizzle ORM.",
				Tags: []string{"react", "frontend", "react-query", "redux", "prisma", "drizzle"},
			},
			{
				Text: "Architecting scalable backends with Golang, NestJS, PostgreSQL, and AWS Fargate serverless containers.",
				Tags: []string{"golang", "backend", "postgresql", "aws", "fargate", "nestjs"},
			},
			{
				Text: "Orchestrated microservices using Kubernetes (K8s), configured ALB/Target Groups, and managed SSL via AWS ACM for high-security healthcare traffic.",
				Tags: []string{"aws", "cloud", "devops", "kubernetes", "k8s"},
			},
			{
				Text: "Streamlined development cycles with GitHub Actions CI/CD and Docker Compose.",
				Tags: []string{"devops", "docker", "github-actions"},
			},
		},
	},
	{
		Company: "Swismax",
		Role:    "Software Engineer",
		Date:    "2024 - 2025",
		Bullets: []DefaultBullet{
			{
				Text: "Developed dashboards using React (MERN Stack), Vue.js, and Material UI (MUI), fetching data via GraphQL and REST APIs.",
				Tags: []string{"react", "frontend", "mern", "graphql", "rest", "vue"},
			},
			{
				Text: "Managed backend services on AWS EC2, writing optimized SQL queries, and transitioned PHP monoliths and Django APIs to containerized microservices.",
				Tags: []string{"aws", "backend", "sql", "php", "docker", "microservices", "python", "django"},
			},
			{
				Text: "Built cross-platform mobile apps with React Native, Expo, and Flutter, and automated testing via Puppeteer.",
				Tags: []string{"mobile", "react-native", "expo", "puppeteer", "flutter"},
			},
			{
				Text: "Delivered scalable SaaS solutions with Tailwind CSS ensuring full responsiveness across all devices.",
				Tags: []string{"tailwind", "frontend"},
			},
		},
	},
}

var DefaultProjects = []Project{
	{
		Title: "Vine LMS (vinelms.com)",
		Bullets: []string{
			"LMS built with Next.js, Node.js/Express, and PostgreSQL, utilizing TanStack Query, Stripe Connect, Reader Pay, and Stripe Meter.",
			"Containerized via Docker & Docker Compose with custom routing via Cloudflare dynamic domains.",
		},
		Tags: []string{"nextjs", "react", "nodejs", "express", "postgresql", "stripe", "docker", "cloudflare", "frontend", "backend"},
	},
	{
		Title: "Healthcare EMR System",
		Bullets: []string{
			"EMR platform built with MERN stack. Utilized Redux for global state and AWS Fargate for scalable API endpoints with ACM encryption.",
		},
		Tags: []string{"react", "nodejs", "express", "mongodb", "redux", "aws", "fargate", "mern", "frontend", "backend"},
	},
	{
		Title: "Anti-Bot Google Search Scraper",
		Bullets: []string{
			"Bypass/scraping engine built with React (Vite), Node.js (TS), and Python (FastAPI).",
			"Uses Puppeteer & SeleniumBase to extract organic search metrics and SGE AI Overviews.",
		},
		Tags: []string{"react", "python", "fastapi", "puppeteer", "selenium", "scraping", "nodejs", "typescript", "frontend", "backend"},
	},
	{
		Title: "Golang Distributed Chat System / Bridge",
		Bullets: []string{
			"High-concurrency chat server built using Golang, WebSockets, and Redis for real-time messaging.",
			"Configured AWS ALB and managed scaling via ECS Fargate and PostgreSQL database.",
		},
		Tags: []string{"golang", "websockets", "redis", "postgresql", "aws", "fargate", "backend"},
	},
	{
		Title: "AI-Powered Code Assistant CLI",
		Bullets: []string{
			"CLI tool built in Go and Python integrating LLMs for automated code generation, search, and page rendering.",
			"Implemented custom caching and token-limiting optimization logic.",
		},
		Tags: []string{"golang", "python", "openai", "llm", "cli", "backend"},
	},
	{
		Title: "Cross-Platform Delivery Mobile App",
		Bullets: []string{
			"Dynamic mobile app built using React Native & Expo with global state management via Redux Toolkit.",
			"Automated build pipelines with Expo Application Services (EAS) and backend on Node.js/MongoDB.",
		},
		Tags: []string{"react-native", "expo", "redux", "nodejs", "mongodb", "mobile"},
	},
	{
		Title: "Serverless Analytics Dashboard",
		Bullets: []string{
			"Serverless analytics web application built with Next.js, Tailwind CSS, AWS Lambda, DynamoDB, and Serverless Framework.",
		},
		Tags: []string{"nextjs", "react", "tailwind", "aws", "serverless", "dynamodb", "frontend"},
	},
	{
		Title: "Enterprise E-Commerce Dashboard",
		Bullets: []string{
			"Admin panel built with Vue.js 3, Pinia, and Tailwind CSS.",
			"Backend architecture designed using NestJS, PostgreSQL, and GraphQL with Redis caching.",
		},
		Tags: []string{"vue", "nestjs", "tailwind", "postgresql", "graphql", "redis", "frontend", "backend"},
	},
	{
		Title: "AI Document Processor & Cloud Pipeline",
		Bullets: []string{
			"Document parser backend built with Python (Django) and Celery for asynchronous task processing.",
			"Orchestrated container deployment using Kubernetes (K8s) on AWS EKS with Prometheus monitoring.",
		},
		Tags: []string{"python", "django", "kubernetes", "k8s", "aws", "backend", "devops"},
	},
	{
		Title: "Cross-Platform Ride Sharing Mobile App",
		Bullets: []string{
			"Mobile application developed using Flutter (Dart) and Google Maps API.",
			"Serverless event-driven architecture using Node.js and AWS Lambda.",
		},
		Tags: []string{"flutter", "mobile", "nodejs", "aws", "backend"},
	},
	{
		Title: "Hospital Management Portal",
		Bullets: []string{
			"Portal built with Angular, RxJS, and TypeScript for real-time patient status tracking.",
		},
		Tags: []string{"angular", "frontend", "typescript"},
	},
}

var DefaultSkills = []DefaultSkillCategory{
	{
		Name: "FRONTEND/UI",
		Items: []SkillItem{
			{Name: "React", Tags: []string{"react", "frontend"}},
			{Name: "Next.js", Tags: []string{"nextjs", "frontend"}},
			{Name: "Vue.js", Tags: []string{"vue", "frontend"}},
			{Name: "Angular", Tags: []string{"angular", "frontend"}},
			{Name: "TypeScript", Tags: []string{"typescript", "frontend", "backend"}},
			{Name: "JavaScript", Tags: []string{"javascript", "frontend", "backend"}},
			{Name: "React Native Expo", Tags: []string{"mobile", "react-native", "expo"}},
			{Name: "Flutter", Tags: []string{"mobile", "flutter"}},
			{Name: "TanStack Start", Tags: []string{"react", "frontend"}},
			{Name: "Redux", Tags: []string{"redux", "react", "frontend"}},
			{Name: "TanStack Query", Tags: []string{"react-query", "react", "frontend"}},
			{Name: "Tailwind", Tags: []string{"tailwind", "frontend"}},
			{Name: "shadcn/ui", Tags: []string{"shadcn", "frontend"}},
			{Name: "MUI", Tags: []string{"mui", "frontend"}},
			{Name: "HTML5/CSS3", Tags: []string{"html", "css", "frontend"}},
		},
	},
	{
		Name: "BACKEND/DATABASE",
		Items: []SkillItem{
			{Name: "Node.js", Tags: []string{"nodejs", "backend"}},
			{Name: "Express.js", Tags: []string{"express", "backend"}},
			{Name: "NestJS", Tags: []string{"nestjs", "backend"}},
			{Name: "FastAPI", Tags: []string{"python", "fastapi", "backend"}},
			{Name: "Django", Tags: []string{"python", "django", "backend"}},
			{Name: "Golang", Tags: []string{"golang", "backend"}},
			{Name: "MERN Stack", Tags: []string{"mern", "react", "nodejs", "mongodb", "backend"}},
			{Name: "PostgreSQL", Tags: []string{"postgresql", "backend", "database"}},
			{Name: "SQL", Tags: []string{"sql", "backend", "database"}},
			{Name: "MongoDB", Tags: []string{"mongodb", "backend", "database"}},
			{Name: "Redis", Tags: []string{"redis", "backend", "database"}},
			{Name: "GraphQL", Tags: []string{"graphql", "backend", "frontend"}},
			{Name: "Drizzle ORM", Tags: []string{"drizzle", "backend"}},
			{Name: "Prisma", Tags: []string{"prisma", "backend"}},
			{Name: "Stripe Connect", Tags: []string{"stripe", "backend"}},
			{Name: "Stripe Reader Pay", Tags: []string{"stripe", "backend"}},
			{Name: "Stripe Meter", Tags: []string{"stripe", "backend"}},
			{Name: "PHP", Tags: []string{"php", "backend"}},
			{Name: "REST APIs", Tags: []string{"rest", "backend"}},
			{Name: "Webhooks", Tags: []string{"webhooks", "backend"}},
		},
	},
	{
		Name: "AWS & CLOUD",
		Items: []SkillItem{
			{Name: "AWS Cloud", Tags: []string{"aws", "cloud"}},
			{Name: "Fargate", Tags: []string{"aws", "fargate", "cloud"}},
			{Name: "EC2", Tags: []string{"aws", "ec2", "cloud"}},
			{Name: "ACM", Tags: []string{"aws", "acm", "cloud"}},
			{Name: "S3", Tags: []string{"aws", "s3", "cloud"}},
			{Name: "ALB", Tags: []string{"aws", "alb", "cloud"}},
			{Name: "Firebase", Tags: []string{"firebase", "cloud"}},
			{Name: "Supabase", Tags: []string{"supabase", "cloud"}},
		},
	},
	{
		Name: "DEVOPS/TOOLS",
		Items: []SkillItem{
			{Name: "Kubernetes (K8s)", Tags: []string{"kubernetes", "k8s", "devops"}},
			{Name: "GitHub Actions", Tags: []string{"github-actions", "devops"}},
			{Name: "CI/CD", Tags: []string{"cicd", "devops"}},
			{Name: "Docker", Tags: []string{"docker", "devops"}},
			{Name: "Puppeteer", Tags: []string{"puppeteer", "scraping"}},
			{Name: "Git/GitHub", Tags: []string{"git", "devops"}},
		},
	},
}

func normalizeTag(t string) string {
	t = strings.ToLower(strings.TrimSpace(t))
	t = strings.ReplaceAll(t, ".", "")
	t = strings.ReplaceAll(t, "-", "")
	t = strings.ReplaceAll(t, " ", "")
	t = strings.ReplaceAll(t, "/", "")
	return t
}

func tagsMatch(itemTags []string, searchTags []string) bool {
	if len(searchTags) == 0 {
		return true
	}
	for _, st := range searchTags {
		stNorm := normalizeTag(st)
		if stNorm == "" {
			continue
		}
		for _, it := range itemTags {
			itNorm := normalizeTag(it)
			if itNorm == "all" || itNorm == stNorm || strings.Contains(itNorm, stNorm) || strings.Contains(stNorm, itNorm) {
				return true
			}
		}
	}
	return false
}

func filterTagsForSection(specific []string, general []string) []string {
	if len(specific) > 0 {
		return specific
	}
	return general
}

func FilterCV(req CVFilterRequest) CVData {
	cv := DefaultCV

	// 1. Filter Summary
	summaryTags := filterTagsForSection(req.SummaryTags, req.GeneralTags)
	var summaryParts []string
	for _, item := range DefaultSummaryItems {
		if tagsMatch(item.Tags, summaryTags) {
			summaryParts = append(summaryParts, item.Text)
		}
	}
	if len(summaryParts) == 0 {
		// Fallback
		for _, item := range DefaultSummaryItems {
			if tagsMatch(item.Tags, []string{"all"}) {
				summaryParts = append(summaryParts, item.Text)
			}
		}
	}
	cv.Summary = strings.Join(summaryParts, " ")

	// 2. Filter Experiences
	expTags := filterTagsForSection(req.ExperienceTags, req.GeneralTags)
	for _, job := range DefaultExperiences {
		var filteredBullets []string
		for _, b := range job.Bullets {
			if tagsMatch(b.Tags, expTags) {
				filteredBullets = append(filteredBullets, b.Text)
			}
		}
		if len(filteredBullets) == 0 {
			for _, b := range job.Bullets {
				filteredBullets = append(filteredBullets, b.Text)
			}
		}
		cv.Experiences = append(cv.Experiences, WorkExperience{
			Company: job.Company,
			Role:    job.Role,
			Date:    job.Date,
			Bullets: filteredBullets,
		})
	}

	// 3. Filter Projects
	projTags := filterTagsForSection(req.ProjectTags, req.GeneralTags)
	for _, proj := range DefaultProjects {
		if tagsMatch(proj.Tags, projTags) {
			cv.Projects = append(cv.Projects, proj)
		}
	}
	// Fallback if no projects match: show all
	if len(cv.Projects) == 0 {
		cv.Projects = DefaultProjects
	}

	// 4. Filter Skills
	skillTags := filterTagsForSection(req.SkillTags, req.GeneralTags)
	for _, cat := range DefaultSkills {
		var filteredItems []string
		for _, item := range cat.Items {
			if tagsMatch(item.Tags, skillTags) {
				filteredItems = append(filteredItems, item.Name)
			}
		}
		if len(filteredItems) == 0 {
			// Fallback: use all in that category
			for _, item := range cat.Items {
				filteredItems = append(filteredItems, item.Name)
			}
		}
		cv.Skills = append(cv.Skills, SkillCategory{
			Name:  cat.Name,
			Items: filteredItems,
		})
	}

	return cv
}
