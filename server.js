const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ========== YOUR CONFIGURATION - CHANGE THESE ==========
const PAYSTACK_SECRET_KEY = 'sk_live_xxxxxxxxxxxxx';  // Get from Paystack dashboard
const VTPASS_EMAIL = 'youremail@gmail.com';           // Your VTpass email
const VTPASS_PASSWORD = 'your_vtpass_password';       // Your VTpass password
const YOUR_WHATSAPP = '2347079197823';                 // Your WhatsApp
// =======================================================

// Store transactions (in production, use a real database like MongoDB Atlas - free)
let transactions = [];

// VTpass Authentication
let vtpassToken = null;
let tokenExpiry = null;

async function getVTpassToken() {
    if (vtpassToken && tokenExpiry > Date.now()) {
        return vtpassToken;
    }
    
    try {
        const response = await axios.post('https://vtpass.com/api/login', {
            email: VTPASS_EMAIL,
            password: VTPASS_PASSWORD
        });
        
        vtpassToken = response.data.token;
        tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
        return vtpassToken;
    } catch (error) {
        console.error('VTpass login failed:', error.response?.data || error.message);
        throw new Error('VTpass authentication failed');
    }
}

// Renew decoder via VTpass
async function renewDecoder(smartcard, service, packageCode, amount) {
    try {
        const token = await getVTpassToken();
        
        // Determine service ID
        let serviceId = '';
        if (service === 'dstv') {
            serviceId = 'dstv';
        } else if (service === 'gotv') {
            serviceId = 'gotv';
        }
        
        const response = await axios.post('https://vtpass.com/api/pay', {
            serviceID: serviceId,
            billersCode: smartcard,
            variation_code: packageCode,
            phone: '07079197823',
            subscription_type: 'monthly'
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        return {
            success: true,
            transactionId: response.data.transactionId,
            message: response.data.message
        };
    } catch (error) {
        console.error('VTpass renewal failed:', error.response?.data || error.message);
        return {
            success: false,
            message: error.response?.data?.message || 'Renewal failed'
        };
    }
}

// Send WhatsApp notification
async function sendWhatsApp(phone, message) {
    // Using WhatsApp API via URL (opens WhatsApp on their phone)
    // For automated WhatsApp, you'd need Twilio or WhatsApp Business API
    console.log(`WhatsApp to ${phone}: ${message}`);
    return true;
}

// Initiate payment endpoint
app.post('/initiate-payment', async (req, res) => {
    const { email, amount, smartcard, service, packageCode, packageName, phone } = req.body;
    
    const reference = 'SIG-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    
    // Store transaction
    const transaction = {
        id: reference,
        reference: reference,
        email: email,
        amount: amount,
        smartcard: smartcard,
        service: service,
        packageCode: packageCode,
        packageName: packageName,
        phone: phone,
        status: 'pending',
        date: new Date().toISOString()
    };
    transactions.push(transaction);
    
    try {
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email,
            amount: amount * 100, // Paystack uses kobo
            reference: reference,
            callback_url: 'https://your-frontend-url.netlify.app/payment-callback.html',
            metadata: {
                smartcard: smartcard,
                service: service,
                packageCode: packageCode,
                packageName: packageName,
                phone: phone
            }
        }, {
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        res.json({
            authorization_url: response.data.data.authorization_url,
            reference: reference
        });
    } catch (error) {
        console.error('Payment init failed:', error.response?.data || error.message);
        res.status(500).json({ error: 'Payment initialization failed' });
    }
});

// Paystack webhook (called when payment is successful)
app.post('/paystack-webhook', async (req, res) => {
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
        return res.status(401).send('Unauthorized');
    }
    
    const event = req.body;
    
    if (event.event === 'charge.success') {
        const transaction = transactions.find(t => t.reference === event.data.reference);
        
        if (transaction && transaction.status === 'pending') {
            transaction.status = 'processing';
            
            // Renew decoder automatically
            const renewal = await renewDecoder(
                transaction.smartcard,
                transaction.service,
                transaction.packageCode,
                transaction.amount
            );
            
            if (renewal.success) {
                transaction.status = 'completed';
                transaction.renewalId = renewal.transactionId;
                
                // Send WhatsApp to you
                await sendWhatsApp(YOUR_WHATSAPP, `✅ AUTO RENEWAL SUCCESS!\n${transaction.service} - ${transaction.packageName}\nSmartcard: ${transaction.smartcard}\nAmount: ₦${transaction.amount}\nCustomer: ${transaction.phone}`);
            } else {
                transaction.status = 'failed';
                transaction.failureReason = renewal.message;
                
                // Notify you to manually renew
                await sendWhatsApp(YOUR_WHATSAPP, `⚠️ AUTO RENEWAL FAILED!\nPayment received but renewal failed.\nSmartcard: ${transaction.smartcard}\nPlease renew manually.\nCustomer: ${transaction.phone}`);
            }
        }
    }
    
    res.sendStatus(200);
});

// Admin endpoint to get transactions
app.get('/admin/transactions', (req, res) => {
    res.json(transactions.reverse());
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', transactions: transactions.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
