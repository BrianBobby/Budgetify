import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const port = 3000;

const db = new pg.Client({
    user: "postgres",
    host: "localhost",
    database: "budgetify",
    password: "bbjoe",
    port: 5432,
});
db.connect();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// GoogleGenerativeAI initialization
const genAI = new GoogleGenerativeAI("AIzaSyC5ycg47M3uOfahKEhM1QVfqv63HJU0LEU");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Function to generate the budget
async function generateBudget() {
    try {
        const incomeQuery = `SELECT SUM(amount) as total_income FROM Income`;
        const expenseQuery = `SELECT expensecategory as category, SUM(amount) as total_expenses FROM Expenses GROUP BY expensecategory`;
        const savingsQuery = `SELECT SUM(amount) as total_savings FROM Savings`;

        const incomeResult = await db.query(incomeQuery);
        const expenseResult = await db.query(expenseQuery);
        const savingsResult = await db.query(savingsQuery);

        const totalIncome = incomeResult.rows[0].total_income;
        const totalSavings = savingsResult.rows[0].total_savings || 0;

        const expenses = expenseResult.rows.map(expense => ({
            category: expense.category,
            amount: expense.total_expenses
        }));

        const prompt = `
            I have an income of ${totalIncome} and savings of ${totalSavings}.
            My expenses are: ${expenses.map(e => `${e.category}: ${e.amount}`).join(", ")}.
            Please create an optimal budgeting plan for me and return only the JSON response without any additional text or explanation. The categories must include Rent, Electricity, Gas, Water, Groceries, Entertainment, Phone Recharge, Other, Savings, and Investments. The amount for Investments should be 20-25% of the savings. Every category except for Rent should have recommended_amount as less than current_amount by a 15-25 percentage. The "notes" field in the JSON should contain only one concise tip or suggestion for each category. The JSON response should have the following structure:
            {
                "budget": [
                    {
                        "category": "Category Name",
                        "current_amount": 0.0,
                        "recommended_amount": 0.0,
                        "notes": "Personalized tip or note for this category"
                    }
                ]
            }
        `;

        const response = await model.generateContent(prompt);
        const aiResponse = await response.response.text();

        // Clean up the response to extract valid JSON
        const cleanedResponse = aiResponse.replace(/```json|```/g, '').trim();
        const jsonStart = cleanedResponse.indexOf('{');
        const jsonEnd = cleanedResponse.lastIndexOf('}') + 1;
        const jsonString = cleanedResponse.substring(jsonStart, jsonEnd);

        const budgetData = JSON.parse(jsonString);

        for (const budget of budgetData.budget) {
            const insertQuery = `
                INSERT INTO Budget (category, recommended_amount, current_amount, notes)
                VALUES ($1, $2, $3, $4)
            `;
            await db.query(insertQuery, [budget.category, budget.recommended_amount, budget.current_amount, budget.notes]);
        }

        return budgetData; // Return the budget data object
    } catch (err) {
        console.error("Error generating budget:", err);
        throw err;
    }
}

app.get("/", async (req, res) => {
    try {
        const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
        const totalIncome = incomeResult.rows[0].total_income || 0;

        const expenseResult = await db.query("SELECT expensecategory, SUM(amount) AS totalamount FROM expenses GROUP BY expensecategory ORDER BY totalamount DESC");
        const totalExpenses = expenseResult.rows;

        const savingsResult = await db.query("SELECT amount FROM savings ORDER BY savingsid DESC");
        const totalSavings = savingsResult.rows[0] ? savingsResult.rows[0].amount : 0;

        // Query for daily expenses
        const dailyExpensesResult = await db.query(`
            SELECT DATE(expensedate) AS expensedate, SUM(amount) AS totalamount
            FROM expenses
            GROUP BY DATE(expensedate)
            ORDER BY DATE(expensedate)
        `);

        const dailyExpenses = dailyExpensesResult.rows.map(row => ({
            date: row.expensedate,
            amount: parseFloat(row.totalamount) // Ensure amount is a float
        }));

        res.render("index.ejs", {
            totalIncome,
            totalExpenses,
            totalSavings,
            dailyExpenses // Pass daily expenses to the view
        });
    } catch (err) {
        console.log(err);
        res.status(500).send("An error occurred while fetching data.");
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
        console.log(err);
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
        console.log(err);
        res.status(500).send("An error occurred while adding this expense.");
    }
});

app.post("/viewexpense", async (req, res) => {
    if (req.body.add === "VIEW EXPENSES") {
        const incomeResult = await db.query("SELECT SUM(amount) AS total_income FROM income");
        const totalIncome = incomeResult.rows[0].total_income || 0;
        const expenseResult = await db.query("SELECT expensecategory, SUM(amount) AS totalamount FROM expenses GROUP BY expensecategory ORDER BY totalamount DESC");
        const totalExpenses = expenseResult.rows;
        const savingsResult = await db.query("SELECT amount FROM savings ORDER BY savingsid DESC");
        const totalSavings = savingsResult.rows[0] ? savingsResult.rows[0].amount : 0;

        res.render("view.ejs", {
            totalIncome,
            totalExpenses,
            totalSavings
        });
    } else {
        res.redirect("/");
    }
});

app.post("/savingscalculator", async (req, res) => {
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
