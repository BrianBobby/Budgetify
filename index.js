
import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import dotenv from "dotenv";
import fetch from "node-fetch"; // ensure node-fetch is installed (npm i node-fetch@2) or use global fetch on Node 18+

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// VIEW engine (if not already set)
app.set("view engine", "ejs");
app.set("views", "./views");

// Use pg.Pool and credentials from .env
const db = new pg.Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});

// call once after pool is created (async)
async function syncSequenceToMax(tableName = 'expenses', pk = 'expenseid') {
  try {
    // get sequence name
    const seqRes = await db.query(
      `SELECT pg_get_serial_sequence($1, $2) AS seq_name`,
      [tableName, pk]
    );
    const seqName = seqRes.rows[0] && seqRes.rows[0].seq_name;
    if (!seqName) {
      console.warn('No serial sequence found for', tableName, pk);
      return;
    }
    // set sequence to MAX(pk) (so next nextval will be max+1)
    const setSql = `SELECT setval('${seqName}', (SELECT COALESCE(MAX(${pk}),0) FROM ${tableName}), true)`;
    await db.query(setSql);
    // console.log(`Sequence ${seqName} synced to table ${tableName}.${pk}`);
  } catch (err) {
    console.error('Error syncing sequence:', err);
  }
}

// call it after db is ready:
syncSequenceToMax('expenses', 'expenseid');


app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// AI / Ollama configuration
const OLLAMA_URL = process.env.OLLAMA_URL || null; // e.g. http://localhost:11434/api/generate
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "mistral";
const USE_MOCK_BUDGET = process.env.MOCK_BUDGET === "true"; // set to true to skip AI entirely

// ---------- Helpers ----------
function extractJsonSubstring(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}') + 1;
  if (jsonStart === -1 || jsonEnd === 0) return null;
  return cleaned.substring(jsonStart, jsonEnd);
}

function normalizeBudgetObject(obj) {
  if (!obj) return null;
  if (obj && Array.isArray(obj.budget)) return { budget: obj.budget };
  if (Array.isArray(obj)) return { budget: obj };
  if (obj && obj.budget && typeof obj.budget === "object") return { budget: [obj.budget] };

  const knownCategories = new Set(["Rent","Electricity","Gas","Water","Groceries","Entertainment","Phone Recharge","Other","Savings","Investments"]);
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    const looksLikeCategoryMap = keys.length > 0 && keys.every(k =>
      typeof obj[k] === "object" &&
      (obj[k].current_amount !== undefined || obj[k].recommended_amount !== undefined || obj[k].amount !== undefined || knownCategories.has(k))
    );
    if (looksLikeCategoryMap) {
      const arr = keys.map(k => {
        const val = obj[k];
        return {
          category: k,
          current_amount: (val.current_amount ?? val.current ?? val.amount ?? 0),
          recommended_amount: (val.recommended_amount ?? val.recommended ?? 0),
          notes: val.notes ?? val.note ?? ""
        };
      });
      return { budget: arr };
    }
  }
  return null;
}

function roundTo2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Build a safe mock budget from DB numbers (used when OLLAMA_URL not present or MOCK enabled)
function buildMockBudgetFromDB(totalSavings, expenses) {
  // expenses is array of { category, amount }
  const expectedCategories = ["Rent","Electricity","Gas","Water","Groceries","Entertainment","Phone Recharge","Other","Savings","Investments"];
  const map = new Map(expenses.map(e => [String(e.category), Number(e.amount)]));
  const budget = [];

  // midpoint reduction factor for non-rent (80% = 20% reduction)
  for (const cat of expectedCategories) {
    const current = roundTo2(map.get(cat) ?? 0);
    let recommended = 0;
    let notes = "";

    if (cat === "Investments") {
      // Investments should be 20-25% of savings
      recommended = roundTo2(totalSavings ? (totalSavings * 0.22) : 0);
      notes = recommended > 0 ? "Allocate part of savings to long-term investments." : "No savings available to invest.";
    } else if (cat === "Savings") {
      // keep savings as from DB
      recommended = current;
      notes = current > 0 ? "Keep building emergency savings." : "No savings recorded yet.";
    } else if (current <= 0) {
      recommended = 0;
      notes = "No current spending recorded; no recommendation.";
    } else if (cat === "Rent") {
      // conservative: recommended = current (don't change) or small reduction
      recommended = roundTo2(current); // leave as-is by default
      notes = "Rent typically fixed — renegotiate lease if possible.";
    } else {
      // non-rent: recommend 75-85% range -> choose midpoint 80%
      recommended = roundTo2(current * 0.80);
      notes = "Trim 15%-25% where possible (plan/coupon/bulk buy).";
    }

    budget.push({
      category: cat,
      current_amount: current,
      recommended_amount: recommended,
      notes
    });
  }

  return { budget };
}

// ---------- Core: generateBudget ----------
async function generateBudget() {
  try {
    // Get DB numbers
    const incomeResult = await db.query(`SELECT SUM(amount) as total_income FROM income`);
    const expenseResult = await db.query(`SELECT expensecategory as category, SUM(amount) as total_expenses FROM expenses GROUP BY expensecategory`);
    const savingsResult = await db.query(`SELECT SUM(amount) as total_savings FROM savings`);

    const totalIncome = parseFloat(incomeResult.rows[0].total_income) || 0;
    const totalSavings = parseFloat(savingsResult.rows[0].total_savings) || 0;
    const expenses = expenseResult.rows.map(r => ({ category: r.category, amount: parseFloat(r.total_expenses) || 0 }));

    // If explicit mock mode, create safe mock and return
    if (USE_MOCK_BUDGET || !OLLAMA_URL) {
      console.warn("generateBudget: using mock budget (MOCK_BUDGET or no OLLAMA_URL configured).");
      return buildMockBudgetFromDB(totalSavings, expenses);
    }

    // Build strict prompt (Ollama)
    const prompt = `
You must return exactly one JSON object and nothing else. Schema:
{
  "budget": [
    {
      "category": "Rent|Electricity|Gas|Water|Groceries|Entertainment|Phone Recharge|Other|Savings|Investments",
      "current_amount": 0.0,
      "recommended_amount": 0.0,
      "notes": "one concise tip (max 20 words)"
    }
  ]
}

Rules:
1) Do NOT change the current_amount values provided (they are authoritative).
2) If current_amount is 0, recommended_amount MUST be 0 and notes must indicate "No current spending recorded; no recommendation."
3) For every category except Rent, recommended_amount MUST be between 75% and 85% of current_amount. Round to two decimals.
4) For Rent, do NOT exceed current_amount; reductions must be conservative (max 10%).
5) Investments recommended_amount should be 20-25% of the total savings provided.
6) Use numeric values (no currency symbols or commas).
7) notes must be one concise tip (max 20 words).
8) Output only the JSON, nothing else.

Context:
Total income: ${totalIncome}
Total savings: ${totalSavings}
Current expenses: ${expenses.map(e => `${e.category}: ${e.amount}`).join(", ")}

Return the JSON now.
`.trim();

    // POST to Ollama (non-streaming)
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json"
      })
    });

    const rawText = await response.text();
    console.log("=== Model raw response START ===");
    console.log(rawText);
    console.log("=== Model raw response END ===");

    // Try parse
    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      // try extracting substring
      const jsonStr = extractJsonSubstring(rawText);
      if (jsonStr) {
        try { parsed = JSON.parse(jsonStr); } catch (e2) { parsed = null; }
      }
    }

    if (!parsed) {
      // try wrapped fields
      try {
        const maybe = JSON.parse(rawText || "{}");
        const cand = ["response","result","output","content","text"];
        for (const f of cand) {
          if (maybe[f] && typeof maybe[f] === "string") {
            const inner = extractJsonSubstring(maybe[f]);
            if (inner) {
              parsed = JSON.parse(inner);
              break;
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (!parsed) {
      throw new Error("Model response could not be parsed as JSON. See server logs for raw response.");
    }

    // Normalize to { budget: [...] }
    let normalized = normalizeBudgetObject(parsed);
    if (!normalized) {
      // last-ditch try inner string fields
      const cand = ["response","result","output","content","text"];
      for (const f of cand) {
        if (parsed[f] && typeof parsed[f] === "string") {
          const inner = extractJsonSubstring(parsed[f]);
          if (inner) {
            try {
              const innerParsed = JSON.parse(inner);
              normalized = normalizeBudgetObject(innerParsed);
              if (normalized) break;
            } catch (e) { }
          }
        }
      }
    }

    if (!normalized) {
      throw new Error("Unable to normalize model output into expected budget structure. Parsed keys: " + Object.keys(parsed).join(", "));
    }

    if (!Array.isArray(normalized.budget)) {
      throw new Error("Normalized budget is not an array.");
    }

    // Server-side validation & clamping (safety net)
    const validBudgets = [];
    for (const item of normalized.budget) {
      if (!item || !item.category) {
        console.warn("Skipping invalid budget item (missing category):", item);
        continue;
      }

      const category = String(item.category).trim();
      const current_amount = Number(item.current_amount ?? item.current ?? item.amount ?? 0) || 0;
      let recommended_amount = Number(item.recommended_amount ?? item.recommended ?? 0) || 0;
      let notes = (item.notes ?? item.note ?? "").toString().trim();

      if (current_amount <= 0) {
        recommended_amount = 0;
        if (!notes) notes = "No current spending recorded; no recommendation.";
        else notes = notes + " (No current spending recorded; recomm. set to 0.)";
      } else {
        if (category.toLowerCase() !== "rent") {
          const minRec = roundTo2(current_amount * 0.75);
          const maxRec = roundTo2(current_amount * 0.85);
          if (recommended_amount > current_amount || recommended_amount < minRec || recommended_amount > maxRec) {
            recommended_amount = roundTo2((minRec + maxRec) / 2);
          }
        } else {
          // rent conservative
          if (recommended_amount > current_amount || recommended_amount <= 0) {
            recommended_amount = roundTo2(current_amount);
          } else {
            const minRent = roundTo2(current_amount * 0.90);
            if (recommended_amount < minRent) recommended_amount = minRent;
          }
        }
        if (!notes) notes = "Review and reduce where possible.";
      }

      validBudgets.push({
        category,
        current_amount: roundTo2(current_amount),
        recommended_amount: roundTo2(recommended_amount),
        notes
      });
    }

    if (validBudgets.length === 0) {
      throw new Error("No valid budget entries found after normalization and validation.");
    }

    // Save to DB
    for (const budget of validBudgets) {
      const insertQuery = `
        INSERT INTO Budget (category, recommended_amount, current_amount, notes)
        VALUES ($1, $2, $3, $4)
      `;
      await db.query(insertQuery, [budget.category, budget.recommended_amount, budget.current_amount, budget.notes]);
    }

    return { budget: validBudgets };

  } catch (err) {
    console.error("Error generating budget:", err);
    // If AI path fails, fallback to mock budget rather than crashing
    try {
      const fallbackExpenses = (await db.query(`SELECT expensecategory as category, SUM(amount) as total_expenses FROM expenses GROUP BY expensecategory`)).rows;
      const totalSavings = parseFloat((await db.query(`SELECT SUM(amount) as total_savings FROM savings`)).rows[0].total_savings) || 0;
      return buildMockBudgetFromDB(totalSavings, fallbackExpenses.map(r => ({ category: r.category, amount: r.total_expenses })));
    } catch (e) {
      throw err; // rethrow original if fallback fails
    }
  }
}

// ---------- Routes ----------

app.get("/", async (req, res) => {
  try {
    const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
    const totalIncome = incomeResult.rows[0].total_income || 0;

    const expenseResult = await db.query("SELECT expensecategory, SUM(amount) AS totalamount FROM expenses GROUP BY expensecategory ORDER BY totalamount DESC");
    const totalExpenses = expenseResult.rows;

    const savingsResult = await db.query("SELECT amount FROM savings ORDER BY savingsid DESC");
    const totalSavings = savingsResult.rows[0] ? savingsResult.rows[0].amount : 0;

    const dailyExpensesResult = await db.query(`
      SELECT DATE(expensedate) AS expensedate, SUM(amount) AS totalamount
      FROM expenses
      GROUP BY DATE(expensedate)
      ORDER BY DATE(expensedate)
    `);

    const dailyExpenses = dailyExpensesResult.rows.map(row => ({
      date: row.expensedate,
      amount: parseFloat(row.totalamount)
    }));

    res.render("index.ejs", {
      totalIncome,
      totalExpenses,
      totalSavings,
      dailyExpenses
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("An error occurred while fetching data.");
  }
});

// Add this near your other routes in index.js
app.get("/viewexpense", async (req, res) => {
  try {
    // Total income
    const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
    const totalIncome = incomeResult.rows[0].total_income || 0;

    // Grouped totals (optional summary)
    const groupedResult = await db.query(
      "SELECT expensecategory, SUM(amount) AS totalamount FROM expenses GROUP BY expensecategory ORDER BY totalamount DESC"
    );
    const totalExpenses = groupedResult.rows;

    // Latest savings
    const savingsResult = await db.query("SELECT amount FROM savings ORDER BY savingsid DESC");
    const totalSavings = savingsResult.rows[0] ? savingsResult.rows[0].amount : 0;

    // All transactions (most recent first)
    const txResult = await db.query(
      `SELECT expenseid, amount, expensecategory, notes, expensedate
       FROM expenses
       ORDER BY expensedate DESC, expenseid DESC`
    );
    const transactions = txResult.rows.map(r => ({
      expenseid: r.expenseid,
      amount: parseFloat(r.amount) || 0,
      expensecategory: r.expensecategory,
      notes: r.notes,
      expensedate: r.expensedate
    }));

    res.render("view.ejs", {
      totalIncome,
      totalExpenses,
      totalSavings,
      transactions
    });
  } catch (err) {
    console.error("Error loading /viewexpense (GET):", err);
    res.status(500).send("Error loading expenses");
  }
});


app.post("/income", (req, res) => {
  if (req.body.add === "INCOME") {
    res.render("income.ejs");
  } else {
    res.redirect("/");
  }
});

app.post("/newincome", async (req, res) => {
  try {
    const amount = req.body.incomeamount;
    const category = req.body.incomecategory;
    const notes = req.body.incomenotes || null;
    await db.query("INSERT INTO income (amount, category, notes) VALUES ($1, $2, $3)", [amount, category, notes]);

    const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
    const totalIncome = incomeResult.rows[0].total_income;

    const expenseResult = await db.query("SELECT SUM(amount) AS total_expenses FROM expenses");
    const totalExpenses = expenseResult.rows[0].total_expenses || 0;

    const savingsAmount = totalIncome - totalExpenses;
    await db.query("DELETE from savings");
    await db.query("INSERT INTO savings (amount, notes) VALUES ($1, $2)", [savingsAmount, "Automatically calculated savings"]);

    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("An error occurred while adding income.");
  }
});

app.post("/expense", (req, res) => {
  if (req.body.add === "EXPENSE") {
    res.render("expense.ejs");
  } else {
    res.redirect("/");
  }
});

app.post("/newexpense", async (req, res) => {
  try {
    const amount = req.body.expenseamount;
    const category = req.body.expensecategory;
    const notes = req.body.expensenotes || null;
    await db.query("INSERT INTO expenses (amount, expensecategory, notes) VALUES ($1, $2, $3)", [amount, category, notes]);

    const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
    const totalIncome = incomeResult.rows[0].total_income;

    const expenseResult = await db.query("SELECT SUM(amount) AS total_expenses FROM expenses");
    const totalExpenses = expenseResult.rows[0].total_expenses || 0;
    const savingsAmount = totalIncome - totalExpenses;
    await db.query("DELETE from savings");
    await db.query("INSERT INTO savings (amount, notes) VALUES ($1, $2)", [savingsAmount, "Automatically calculated savings"]);

    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("An error occurred while adding this expense.");
  }
});


// --- Render ALL expense transactions (not grouped) ---
app.post("/viewexpense", async (req, res) => {
  try {
    // Total income (unchanged)
    const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
    const totalIncome = incomeResult.rows[0].total_income || 0;

    // Grouped totals (you might still want to show this in a summary)
    const groupedResult = await db.query(
      "SELECT expensecategory, SUM(amount) AS totalamount FROM expenses GROUP BY expensecategory ORDER BY totalamount DESC"
    );
    const totalExpenses = groupedResult.rows;

    // Latest savings
    const savingsResult = await db.query("SELECT amount FROM savings ORDER BY savingsid DESC");
    const totalSavings = savingsResult.rows[0] ? savingsResult.rows[0].amount : 0;

    // --- NEW: Fetch every single transaction (most recent first) ---
    // Make sure your expenses table has columns: expenseid, amount, expensecategory, expensedate, notes
    const txResult = await db.query(
      `SELECT expenseid, amount, expensecategory, notes, expensedate
       FROM expenses
       ORDER BY expensedate DESC, expenseid DESC`
    );
    // Ensure amounts are numbers in JS and not strings
    const transactions = txResult.rows.map(r => ({
      expenseid: r.expenseid,
      amount: parseFloat(r.amount) || 0,
      expensecategory: r.expensecategory,
      notes: r.notes,
      expensedate: r.expensedate // keep raw date object / string
    }));

    res.render("view.ejs", {
      totalIncome,
      totalExpenses,
      totalSavings,
      transactions
    });
  } catch (err) {
    console.error("Error loading transactions for viewexpense:", err);
    res.status(500).send("Error loading expenses");
  }
});

// DELETE expense by expenseid (safe & validated)
app.post('/expense/delete', async (req, res) => {
  try {
    const id = req.body.id ?? req.body.expenseid; // accept either name just in case
    console.log('Delete request received for id:', id);

    if (!id) {
      console.warn('No id provided to /expense/delete');
      return res.redirect('/viewexpense');
    }

    // Validate numeric id
    const idNum = Number(id);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      console.warn('Invalid id for deletion:', id);
      return res.redirect('/viewexpense');
    }

    // Use the actual PK column name expenseid
    const sql = 'DELETE FROM expenses WHERE expenseid = $1';
    await db.query(sql, [idNum]);

    return res.redirect('/viewexpense');
  } catch (err) {
    console.error('Error deleting expense:', err);
    return res.status(500).send('Error deleting expense');
  }
});



app.post("/savingscalculator", (req, res) => {
  if (req.body.add === "SAVINGS CALCULATOR") {
    res.render("calcsavings.ejs");
  } else {
    res.redirect("/");
  }
});

app.post("/generatebudget", async (req, res) => {
  if (req.body.add === "GENERATE BUDGET") {
    try {
      const budgetData = await generateBudget();
      res.render("budget.ejs", { budgetResponse: budgetData });
    } catch (err) {
      console.error(err);
      res.status(500).send("An error occurred while generating the budget.");
    }
  } else {
    res.redirect("/");
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
