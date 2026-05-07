// =================================================================
// টেলিগ্রাম বট কীবোর্ড মেনু
// =================================================================
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Start Earning 💸' }],
            [{ text: 'Balance 💰' }, { text: 'Refer 👥' }],
            [{ text: 'Ads 📊' }, { text: 'Rules 📚' }]
        ],
        resize_keyboard: true
    }
};

const earningMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '📢 Join Chats' }, { text: '🤖 Message Bots' }],
            [{ text: '🎁 Daily Claim' }, { text: '👨‍💻 Micro Tasks' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

// =================================================================
// টেলিগ্রাম বট লজিক (/start)
// =================================================================
// (আপনার আগের /start লজিক ঠিক থাকবে, শুধু শেষে replyKeyboard এর জায়গায় mainMenu দিবেন)

// =================================================================
// মেসেজ এবং বাটন ক্লিক হ্যান্ডলার
// =================================================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    // যদি কমান্ড /start হয়, তাহলে এখানে কিছু করবে না (আগের হ্যান্ডলারে কাজ হবে)
    if (text.startsWith('/start')) return;

    // চেক চ্যানেল সাবস্ক্রিপশন (যদি ইউজার মেনু ব্যবহার করে)
    const notJoined = await checkForceSub(userId);
    if (notJoined !== true && notJoined.length > 0) {
        bot.sendMessage(chatId, "⚠️ You have left our channel! Please send /start to verify again.");
        return;
    }

    // ----------------------------------------------------
    // Main Menu Logic
    // ----------------------------------------------------
    if (text === 'Start Earning 💸') {
        bot.sendMessage(chatId, "👇 Choose an option to start earning:", earningMenu);
    } 
    else if (text === 'Balance 💰') {
        const doc = await db.collection('users').doc(userId).get();
        const data = doc.exists ? doc.data() : {};
        
        // ব্যালেন্স 5 ডিজিট এবং Bux 2 ডিজিট ফরম্যাট করা
        const dollarBal = (data.balance || 0).toFixed(5);
        const buxBal = (data.tasksCompleted || 0).toFixed(2); // উদাহরণস্বরূপ টাস্ক কমপ্লিটকে Bux ধরা হলো

        const balanceMsg = `💸 Your current balance is: ${dollarBal}$\n💰 Rewards is: ${buxBal}Bux`;
        bot.sendMessage(chatId, balanceMsg);
    } 
    else if (text === 'Refer 👥') {
        const doc = await db.collection('users').doc(userId).get();
        const data = doc.exists ? doc.data() : {};
        const refCode = data.referralCode || "N/A";
        const totalRefer = data.referralsCount || 0;

        // বটের ইউজারনেম ডায়নামিক ভাবে নেওয়া
        const botInfo = await bot.getMe();
        const botUsername = botInfo.username;
        const referLink = `https://t.me/${botUsername}?start=${refCode}`;
        const shareText = encodeURIComponent(`Start earning with GBuxBot! Click here:`);

        const referMsg = `👥 <b>Your Referral System</b>\n\n🔗 <b>Your Link:</b> <code>${referLink}</code>\n📈 <b>Total Referrals:</b> ${totalRefer}\n\nShare your link with friends to earn more!`;

        bot.sendMessage(chatId, referMsg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    // Copy Text বাটন (Telegram এর নতুন ফিচারে সাপোর্ট করে)
                    [{ text: '📋 Copy Refer link', copy_text: { text: referLink } }],
                    [
                        { text: '📈 My Referrers', callback_data: 'my_referrers' },
                        // Telegram Share Link
                        { text: '👥 Share Refer link', url: `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${shareText}` }
                    ]
                ]
            }
        });
    } 
    else if (text === 'Ads 📊') {
        // Ads এ ক্লিকেবল বোল্ড টেক্সট
        bot.sendMessage(chatId, `<b><a href="https://t.me/RedExChangerBot/app">Exchange Cryptos to BDT</a></b>`, { parse_mode: 'HTML' });
    } 
    else if (text === 'Rules 📚') {
        bot.sendMessage(chatId, "📚 Rules:\n1. Do not use multiple accounts.\n2. Complete tasks honestly.");
    }

    // ----------------------------------------------------
    // Start Earning (Sub-menu) Logic
    // ----------------------------------------------------
    else if (text === '📢 Join Chats') {
        bot.sendMessage(chatId, "📢 Join Chats tasks coming soon!");
    }
    else if (text === '🤖 Message Bots') {
        bot.sendMessage(chatId, "🤖 Message Bots tasks coming soon!");
    }
    else if (text === '🎁 Daily Claim') {
        bot.sendMessage(chatId, "🎁 Daily Claim coming soon!");
    }
    else if (text === '👨‍💻 Micro Tasks') {
        // Micro Tasks এ ক্লিক করলে WebApp ওপেন হবে
        const webAppUrl = `https://gbuxbot.onrender.com/?userId=${userId}`;
        bot.sendMessage(chatId, "Click below to open Micro Tasks and start earning!", {
            reply_markup: {
                inline_keyboard: [[{ text: '🚀 Open Tasks Web App', web_app: { url: webAppUrl } }]]
            }
        });
    }
    else if (text === '🔙 Back') {
        // Back এ ক্লিক করলে আবার Main Menu তে ফেরত যাবে
        bot.sendMessage(chatId, "🏠 Returning to Main Menu...", mainMenu);
    }
});

// =================================================================
// ইনলাইন বাটন (Callback Query) হ্যান্ডলার
// =================================================================
bot.on('callback_query', async (query) => {
    const userId = query.from.id.toString();
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'my_referrers') {
        try {
            // ডাটাবেস থেকে ইউজার চেক করে তার রেফারেল কোড বের করা
            const userDoc = await db.collection('users').doc(userId).get();
            if (!userDoc.exists) return;
            const refCode = userDoc.data().referralCode;

            // যারা এই রেফারেল কোড ব্যবহার করে জয়েন করেছে তাদের খোঁজা (ধরে নিচ্ছি আপনি referredBy ফিল্ড সেভ করেন)
            const refsSnapshot = await db.collection('users').where('referredBy', '==', refCode).get();
            
            if (refsSnapshot.empty) {
                bot.answerCallbackQuery(query.id, { text: "You haven't referred anyone yet!", show_alert: true });
                return;
            }

            let msgText = "📈 <b>Your Referrers List:</b>\n\n";
            let count = 1;
            refsSnapshot.forEach(doc => {
                const u = doc.data();
                msgText += `${count}. ${u.firstName} (ID: <code>${u.userId}</code>)\n`;
                count++;
            });

            bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
            bot.answerCallbackQuery(query.id); // লোডিং স্ট্যাটাস বন্ধ করার জন্য

        } catch (error) {
            console.error(error);
            bot.answerCallbackQuery(query.id, { text: "Error loading referrers.", show_alert: true });
        }
    }
});
