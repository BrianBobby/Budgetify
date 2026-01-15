# 💰 Budgetify

**Budgetify** is a full-stack personal finance web application that helps users track income, expenses, savings, and generate personalized budget recommendations. It provides visual insights through charts and supports AI-assisted budgeting using **Ollama**, with a safe mock fallback when AI is unavailable.

---

## 🚀 Features

- 📥 Add and manage **income**
- 💸 Add, view, and delete **expenses**
- 📊 Visual expense analytics using **Chart.js**
  - Expense category breakdown
  - Daily expense trends
- 💾 Automatic **savings calculation**
- 🎯 **Savings goal calculator**
- 🤖 **AI-generated budget recommendations**
  - Uses Ollama (Mistral by default)
  - Safe fallback mock budget when AI is unavailable
- 🗄️ PostgreSQL-backed persistent storage
- 🎨 Server-rendered UI with **EJS**

---
## 🤖 AI Budget Generation

Budgetify can generate intelligent budget recommendations using **Ollama**.

- Enforces strict rules for safety and realism  
- Automatically normalizes and validates AI output  
- Falls back to a deterministic mock budget if:
  - Ollama is unavailable
  - `MOCK_BUDGET=true` is set

### Supported Categories
- Rent
- Electricity
- Gas
- Water
- Groceries
- Entertainment
- Phone Recharge
- Other
- Savings
- Investments

---

## 📊 Charts & Insights

- **Pie chart**: Expense distribution by category  
- **Line chart**: Daily expense trends  
- Charts update dynamically based on stored database data

---

## 🔒 Security & Best Practices

- Uses environment variables for credentials  
- Ignores `node_modules` and `.env` via `.gitignore`  
- Server-side validation for AI responses  
- Safe deletion of expenses with user confirmation

---


## 🛠️ Tech Stack

### Frontend
- EJS (server-side rendering)
- HTML5, CSS3
- Chart.js

### Backend
- Node.js
- Express.js
- Body-Parser
- PostgreSQL (`pg`)

### AI
- Ollama (local LLM)

## ⚙️ Installation & Setup

### 1. Clone the repository
~~~bash
git clone https://github.com/YOUR_USERNAME/Budgetify.git
cd Budgetify
~~~

### 2. Install dependencies
~~~bash
npm install
~~~

### 3. Environment Variables

Create a `.env` file in the root directory with the following contents:

~~~env
PORT=3000

DB_USER=your_db_user
DB_HOST=localhost
DB_NAME=budgetify
DB_PASSWORD=your_password
DB_PORT=5432

# Optional AI configuration
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=mistral
MOCK_BUDGET=false
~~~

⚠️ **Do not commit `.env`** — use `.env.example` instead.

---

## 🗄️ PostgreSQL Database Setup

Create the following tables in your PostgreSQL database:

~~~sql
CREATE TABLE income (
  incomeid SERIAL PRIMARY KEY,
  amount NUMERIC NOT NULL,
  category TEXT,
  notes TEXT
);

CREATE TABLE expenses (
  expenseid SERIAL PRIMARY KEY,
  amount NUMERIC NOT NULL,
  expensecategory TEXT,
  notes TEXT,
  expensedate TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE savings (
  savingsid SERIAL PRIMARY KEY,
  amount NUMERIC NOT NULL,
  notes TEXT
);

CREATE TABLE budget (
  budgetid SERIAL PRIMARY KEY,
  category TEXT,
  recommended_amount NUMERIC,
  current_amount NUMERIC,
  notes TEXT
);
~~~

---

## ▶️ Running the Application

~~~bash
npm start
~~~

Open in your browser:

~~~text
http://localhost:3000
~~~

---


## 📄 License

This project is intended for educational and personal use.  
Feel free to fork and extend it.

