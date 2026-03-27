
import {
  executeIntent,
  buildContext,
  classifyIntent,
  saveSupportTicket,
  listPendingSupport,
  answerSupportTicket,
  getRecentMemory,
  saveMemory,
  askGroq
, trackVisit, addRating, addComment, saveSiteUserProfile, getRecommendations, getReportsSummary} from "../lib/core.js";

function setCors(res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
}

function adminChatPrompt(context){
  return `أنت مساعد إداري ذكي لنظام Rebranding.
ارجع JSON فقط لو قدرت تحدد تنفيذ.
الصيغة:
{"mode":"intent","intent":{"type":"..."}} أو {"mode":"chat","reply":"..."}
الأنواع المتاحة:
get_stats
list_expiring_offers
find_incomplete_accounts
send_push
upsert_user
delete_user
add_offer
edit_offer
delete_offer
add_account
edit_account
delete_account

قواعد:
- لو السؤال عن "الأسئلة المعلقة" استخدم chat فقط ودع النظام يتعامل معها.
- لو البيانات ناقصة قل ذلك في reply بدل تنفيذ ناقص.
- استخدم العربية.
ملخص السياق:
accounts=${context.accounts.length}
offers=${context.offers.length}
users=${context.users.length}`;
}

function websitePrompt(context){
  const accs = context.accounts.slice(0,20).map(a=>({name:a.name,category:a.category,description:a.description}));
  const offs = context.offers.slice(0,20).map(o=>({title:o.title,description:o.description,expiryDate:o.expiryDate}));
  return `أنت بوت خدمة عملاء لموقع Rebranding.
ممنوع تمامًا تنفذ أوامر إدارية أو تفتح الداشبورد.
جاوب فقط من البيانات المتاحة.
لو مش عارف الإجابة أو السؤال يحتاج تدخل بشري، ارجع JSON فقط:
{"mode":"escalate","reply":"..."}
ولو تعرف تجاوب ارجع:
{"mode":"chat","reply":"..."}
بيانات الحسابات: ${JSON.stringify(accs)}
بيانات العروض: ${JSON.stringify(offs)}`;
}

function extractJson(text) {
  try { return JSON.parse(String(text||"").trim()); } catch {}
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON");
  return JSON.parse(m[0]);
}

function ruleBasedReply(message, source, context){
  const text=String(message||'').trim();
  const low=text.toLowerCase();

  if(source==='website_bot'){
    if (/(عرض|عروض|خصم)/.test(text)) {
      const active = context.offers.filter(o => !o.expiryDate || o.expiryDate >= context.today).slice(0,5);
      if (active.length) return '🎯 العروض الحالية:\n' + active.map(o=>`• ${o.title || 'عرض'}${o.description ? ' — '+o.description : ''}`).join('\n');
      return 'حاليًا مفيش عروض واضحة في البيانات.';
    }
    if (/(حساب|اكونت|أكونت|براند|brand)/.test(text)) {
      const sample = context.accounts.slice(0,5);
      if (sample.length) return '🧾 أمثلة من الحسابات المتاحة:\n' + sample.map(a=>`• ${a.name || a.id}${a.category ? ' — '+a.category : ''}`).join('\n');
      return 'مفيش حسابات ظاهرة في البيانات الحالية.';
    }
    return 'محتاج أتأكد من سؤالك أكتر. اكتب اسم الأكونت أو نوع الخدمة، ولو السؤال خارج البيانات الحالية هيتحول للإدارة.';
  }

  if(/(احصائيات|احصائيه|stats)/.test(low)) {
    const activeOffers = context.offers.filter(o => !o.expiryDate || o.expiryDate >= context.today).length;
    return `📊 الإحصائيات الحالية\n• الأكونتات: ${context.accounts.length}\n• العروض الفعالة: ${activeOffers}\n• المستخدمين: ${context.users.length}`;
  }
  if(/(الاسئلة المعلقة|الأسئلة المعلقة|pending|support)/.test(low)) return null;
  return 'أنا جاهز أساعدك. اكتب الطلب بشكل أوضح، مثل: ضيف يوزر باسم أحمد، أو هات الإحصائيات.';
}

export default async function handler(req,res){
  setCors(res);
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method==='GET') return res.status(200).json({ok:true,message:'AI route alive'});
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});

  try{
    const body=req.body || {};
    const message=String(body.message||'').trim();
    const source=String(body.source||'admin_chat');
    const actorId=String(body.actorId||body.chatId||'unknown');
    const sessionId=String(body.sessionId||body.chatId||actorId||Date.now());
    const supportTicketId=String(body.supportTicketId||'').trim();


    if (body.event === 'visit') {
      await trackVisit({ sessionId, actorId, page: body.page || 'home', itemId: body.itemId || '', itemType: body.itemType || 'page' });
      return res.status(200).json({ ok: true, tracked: true });
    }

    if(!message) return res.status(400).json({ok:false,reply:'ابعت رسالة الأول.'});

    const context = await buildContext();

    if (supportTicketId) {
      const reply = await answerSupportTicket(supportTicketId, message, actorId);
      await saveMemory(sessionId,'user',message);
      await saveMemory(sessionId,'assistant',reply);
      return res.status(200).json({ok:true,reply,performed:true});
    }

    if (source === 'website_bot') {
      let reply='';
      let escalated=false;

      if (/(رشح|اقترح|recommend)/i.test(message)) {
        const recs = await getRecommendations({ sessionId, limit: 5 });
        const reply = recs.length ? '✨ ترشيحات مناسبة ليك:\n' + recs.map((r,i)=>`${i+1}) ${r.name || r.id}${r.category ? ` — ${r.category}` : ''}`).join('\n') : 'محتاج بيانات أكتر شوية علشان أرشح لك بشكل أدق.';
        await saveMemory(sessionId,'user',message);
        await saveMemory(sessionId,'assistant',reply);
        return res.status(200).json({ok:true,reply,mode:'chat',recommendations:recs});
      }
      if (/(قيم|تقييم|rate)/i.test(message)) {
        const m = message.match(/(\d(?:\.\d)?)/);
        const rating = m ? Number(m[1]) : 5;
        const acc = (message.match(/(?:حساب|اكونت|أكونت)\s+([^\n،]+)/i)||[])[1] || '';
        const reply = await addRating({ sessionId, actorId, accountId: acc.trim(), rating, comment: body.comment || '' });
        await saveMemory(sessionId,'user',message);
        await saveMemory(sessionId,'assistant',reply);
        return res.status(200).json({ok:true,reply,mode:'chat'});
      }
      if (/(تعليق|comment)/i.test(message)) {
        const acc = (message.match(/(?:حساب|اكونت|أكونت)\s+([^\n،]+)/i)||[])[1] || '';
        const cleaned = message.replace(/^(?:ضيف\s*)?(?:تعليق|comment)\s*/i,'').trim();
        const reply = await addComment({ sessionId, actorId, accountId: acc.trim(), text: cleaned || body.comment || message, author: body.customerName || 'زائر' });
        await saveMemory(sessionId,'user',message);
        await saveMemory(sessionId,'assistant',reply);
        return res.status(200).json({ok:true,reply,mode:'chat'});
      }
      if (/(سجلني|اعمل حساب|create account|signup|register)/i.test(message) && (body.customerName || body.customerEmail)) {
        const reply = await saveSiteUserProfile({ sessionId, name: body.customerName || '', email: body.customerEmail || '' });
        await saveMemory(sessionId,'user',message);
        await saveMemory(sessionId,'assistant',reply);
        return res.status(200).json({ok:true,reply,mode:'chat'});
      }

      try{
        const raw=await askGroq([{role:'system',content:websitePrompt(context)},{role:'user',content:message}]);
        const plan=extractJson(raw);
        if(plan.mode==='escalate'){
          const ticket = await saveSupportTicket({
            sessionId,
            actorId,
            question: message,
            source,
            customerName: body.customerName || '',
            customerContact: body.customerContact || ''
          });
          reply = plan.reply || 'هحوّل سؤالك للإدارة وهيتم الرد عليك قريب.';
          escalated = true;
          await saveMemory(sessionId,'user',message);
          await saveMemory(sessionId,'assistant',reply);
          return res.status(200).json({ok:true,reply,escalated,ticketId:ticket.id});
        }
        reply = plan.reply || ruleBasedReply(message, source, context);
      }catch(e){
        reply = ruleBasedReply(message, source, context);
      }
      await saveMemory(sessionId,'user',message);
      await saveMemory(sessionId,'assistant',reply);
      return res.status(200).json({ok:true,reply,mode:'chat'});
    }

    let reply='';
    let performed=false;

    if (/(التقارير|لوحة التقارير|reports|report)/i.test(message)) {
      const s = await getReportsSummary();
      reply = `📈 لوحة التقارير
• الزيارات: ${s.visits}
• التقييمات: ${s.ratings}
• متوسط التقييم: ${s.averageRating}/5
• التعليقات: ${s.comments}
• الأسئلة المعلقة: ${s.pendingSupport}
• الأكونتات: ${s.accounts}
• العروض: ${s.offers}
• المستخدمين: ${s.users}`;
      performed = true;
    } else if (/(الاسئلة المعلقة|الأسئلة المعلقة|pending|support)/i.test(message)) {
      reply = await listPendingSupport();
      performed = true;
    } else {
      const memory = await getRecentMemory(sessionId);
      try{
        const raw=await askGroq([{role:'system',content:adminChatPrompt(context)}, ...memory, {role:'user',content:message}]);
        const plan=extractJson(raw);
        if(plan?.mode==='intent' && plan.intent){
          reply = await executeIntent(plan.intent, context, source);
          performed = true;
        } else if(plan?.mode==='chat' && plan.reply){
          reply = plan.reply;
        }
      }catch(e){
        reply = '';
      }

      if(!reply){
        try{
          const intent = await classifyIntent(message, context);
          if(intent.type && intent.type !== 'unknown'){
            reply = await executeIntent(intent, context, source);
            performed = true;
          }
        }catch(e){}
      }

      if(!reply){
        reply = ruleBasedReply(message, source, context) || 'مش واضح 100%، اكتب الطلب بشكل أوضح.';
      }
    }

    await saveMemory(sessionId,'user',message);
    await saveMemory(sessionId,'assistant',reply);

    return res.status(200).json({ok:true,reply,performed,source,missingFirebase:!!context.missingFirebase});
  }catch(e){
    return res.status(200).json({
      ok:true,
      reply:'في مشكلة بسيطة في البوت، لكن الواجهة شغالة. جرّب تاني خلال لحظة.',
      error:String(e?.message||e)
    });
  }
}
