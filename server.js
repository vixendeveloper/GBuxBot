// =================================================================
// ১. প্রয়োজনীয় মডিউল ইম্পোর্ট এবং কনফিগারেশন
// =================================================================
require('dotenv').config(); // লোকাল ডেভেলপমেন্টের জন্য .env ফাইল থেকে ভেরিয়েবল লোড করে
const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// Render-এর এনভায়রনমেন্ট ভেরিয়েবল থেকে টোকেন নিন
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase Admin SDK ইনিশিয়ালাইজেশন
// Render-এ এই JSON ডেটা সরাসরি এনভায়রনমেন্ট ভেরিয়েবলে রাখতে হবে
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// =================================================================
// ২. মিডলওয়্যার সেটআপ
// =================================================================
app.use(express.json()); // JSON বডি পার্স করার জন্য
app.use(express.static(path.join(__dirname))); // স্ট্যাটিক ফাইল (HTML, CSS) সার্ভ করার জন্য

// =================================================================
// ৩. টেলিগ্রাম বট লজিক
// =================================================================

// '/start' কমান্ড হ্যান্ডলার
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const firstName = msg.from.first_name;

  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();

    // যদি ব্যবহারকারী নতুন হয়, তাহলে ডাটাবেসে এন্ট্রি তৈরি করুন
    if (!doc.exists) {
      const referralCode = uuidv4().split('-')[0]; // একটি ছোট ইউনিক কোড তৈরি করুন
      await userRef.set({
        userId: userId,
        firstName: firstName,
        balance: 0,
        tasksCompleted: 0,
        completedTasks: [],
        referralCode: referralCode,
        referralsCount: 0,
        joinedAt: new Date(),
      });
    }

    // আপনার Render অ্যাপের URL
    const webAppUrl = `https://your-render-app-name.onrender.com/?userId=${userId}&firstName=${encodeURIComponent(firstName)}`;

    const welcomeMessage = `🎉 Welcome to GBuxBot, ${firstName}!\n\nComplete tasks, invite friends, and earn money. Click the button below to open the app and start earning!`;
    
    // Web App খোলার জন্য একটি ইনলাইন কীবোর্ড বাটন পাঠান
    bot.sendMessage(chatId, welcomeMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Open App & Earn', web_app: { url: webAppUrl } }]
        ]
      }
    });

  } catch (error) {
    console.error("Error handling /start command:", error);
    bot.sendMessage(chatId, "Sorry, something went wrong. Please try again later.");
  }
});

// =================================================================
// ৪. API এন্ডপয়েন্ট (আপনার HTML ফাইল থেকে কল করা হবে)
// =================================================================

// রুট পাথ - আপনার HTML ফাইলটি সার্ভ করবে
app.get('/', (req, res) => {
    // এখানে আপনার HTML ফাইলের নাম দিন
    res.sendFile(path.join(__dirname, 'index.html')); 
});


// API: ব্যবহারকারীর ডেটা পান বা তৈরি করুন
app.post('/api/user', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      // যদি কোনো কারণে /start কমান্ড ছাড়া সরাসরি আসে
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(200).json(doc.data());
  } catch (error) {
    console.error("API Error (/api/user):", error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API: সমস্ত টাস্ক লোড করুন
app.post('/api/tasks', async (req, res) => {
    try {
        const tasksSnapshot = await db.collection('tasks').get();
        const tasks = {};
        tasksSnapshot.forEach(doc => {
            tasks[doc.id] = { taskId: doc.id, ...doc.data() };
        });
        res.status(200).json(tasks);
    } catch (error) {
        console.error("API Error (/api/tasks):", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// API: টাস্ক সম্পন্ন করুন
app.post('/api/complete-task', async (req, res) => {
    const { userId, taskId } = req.body;
    if (!userId || !taskId) {
        return res.status(400).json({ error: 'User ID and Task ID are required' });
    }
    
    const userRef = db.collection('users').doc(userId);
    const taskRef = db.collection('tasks').doc(taskId);

    try {
        const userDoc = await userRef.get();
        const taskDoc = await taskRef.get();

        if (!userDoc.exists || !taskDoc.exists) {
            return res.status(404).json({ error: 'User or Task not found' });
        }

        const userData = userDoc.data();
        const taskData = taskDoc.data();

        // চেক করুন টাস্কটি ইতিমধ্যে সম্পন্ন হয়েছে কিনা
        if (userData.completedTasks && userData.completedTasks.includes(taskId)) {
            return res.status(400).json({ error: 'Task already completed' });
        }
        
        // ব্যালেন্স আপডেট করুন এবং টাস্কটিকে সম্পন্ন হিসাবে চিহ্নিত করুন
        const newBalance = (userData.balance || 0) + taskData.rewardAmount;
        
        await userRef.update({
            balance: newBalance,
            tasksCompleted: admin.firestore.FieldValue.increment(1),
            completedTasks: admin.firestore.FieldValue.arrayUnion(taskId)
        });

        res.status(200).json({ success: true, message: 'Task completed successfully!' });

    } catch (error) {
        console.error("API Error (/api/complete-task):", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// অন্যান্য API এন্ডপয়েন্টগুলো (create-task, withdrawal-request, referral-list) একইভাবে তৈরি করতে পারেন।
// আমি একটি উদাহরণ দিচ্ছি:
app.post('/api/referral-list', async (req, res) => {
    // এই লজিকটি আরও উন্নত করতে হবে, যেখানে আপনি রেফারেল ট্র্যাক করবেন।
    // আপাতত একটি খালি তালিকা পাঠানো হচ্ছে।
    res.status(200).json([]);
});

// =================================================================
// ৫. সার্ভার চালু করুন
// =================================================================
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
