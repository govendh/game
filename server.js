const { Resend } = require('resend');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// RESEND SETUP
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const dbpass = process.env.DB_PASSWORD;

mongoose.connect(dbpass)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log("MongoDB Error:", err));

// =========================
// Schemas
// =========================

const RoomSchema = new mongoose.Schema({
  roomId: { type: String, index: true },
  hashedPasscode: String,
  createdBy: { name: String, email: String },
  createdAt: { type: Date, default: Date.now },
  expiresAt: Date
});

const HistorySchema = new mongoose.Schema({
  game: String,
  playerA: { name: String, email: String, score:Number },
  playerB: { name: String, email: String, score:Number },
  winner: String,
  reason: String,
  totalRounds:Number,
  createdAt: { type: Date, default: Date.now }
});

const Room = mongoose.model("Room", RoomSchema);
const History = mongoose.model("History", HistorySchema);

// =========================
// Socket.IO
// =========================
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

const rooms = {};

// =========================
// CREATE ROOM
// =========================
function generatePasscode(){
  return Math.floor(100000 + Math.random()*900000).toString();
}

app.post("/api/create-room", async (req,res)=>{
  const { name,email } = req.body;

  if(!name || !email)
    return res.json({ error:"Name & email required" });

  const roomId = crypto.randomBytes(4).toString("hex");
  const passcode = generatePasscode();
  const hashedPasscode = await bcrypt.hash(passcode,10);

  const expiresAt = new Date(Date.now()+30*60*1000);

  await Room.create({
    roomId,
    hashedPasscode,
    createdBy:{ name,email },
    expiresAt
  });

  res.json({
    roomId,
    passcode,
    link:`https://game-kh41.onrender.com/game.html?room=${roomId}&code=${passcode}`
  });
});

// JOIN VERIFY
app.post("/api/join-room", async (req,res)=>{
  const { roomId,passcode } = req.body;

  const room = await Room.findOne({ roomId });
  if(!room) return res.json({ success:false });

  const ok = await bcrypt.compare(passcode,room.hashedPasscode);
  if(!ok) return res.json({ success:false });

  res.json({ success:true });
});

// =========================
// EMAIL TEMPLATES
// =========================
function cardHTML(title, subtitle, p1, p2, s1, s2, rounds, color) {
  return `
  <div style="font-family:Arial;background:#0f172a;padding:20px;color:#fff">
    <div style="max-width:520px;margin:auto;background:#111827;border-radius:12px;padding:24px">
      <h2 style="text-align:center;color:${color};margin:0 0 10px">${title}</h2>
      <p style="text-align:center;margin:0 0 16px">${subtitle}</p>

      <div style="background:#1f2937;border-radius:10px;padding:14px">
        <p style="margin:6px 0"><b>${p1.name}</b> (${s1}) vs <b>${p2.name}</b> (${s2})</p>
        <p style="margin:6px 0">Total Rounds: ${rounds}</p>
      </div>

      <p style="text-align:center;margin-top:16px;color:#9ca3af;font-size:12px">
        🎮 Stone • Paper • Scissor Arena
      </p>
    </div>
  </div>`;
}

async function sendMatchEmails(p1, p2, s1, s2, rounds, reason){
  if(!p1?.email || !p2?.email){
    console.log("Mail skipped: missing recipient(s)");
    return;
  }

  let winner=null, loser=null;

  if(s1>s2){ winner=p1; loser=p2; }
  else if(s2>s1){ winner=p2; loser=p1; }
  else {
    if(reason === "leave" || reason === "disconnect"){
      winner = p1;
      loser = p2;
    }
  }

  try{
    // DRAW
    if(!winner){
      await resend.emails.send({
        from: "Game Arena <onboarding@resend.dev>",
        to: [p1.email, p2.email],
        subject: "🤝 Match Draw!",
        html: cardHTML(
          "🤝 Match Draw",
          "Great game! You both were evenly matched.",
          p1,p2,s1,s2,rounds,"#facc15"
        )
      });
      return;
    }

    // WINNER
    await resend.emails.send({
      from: "Game Arena <onboarding@resend.dev>",
      to: [winner.email],
      subject: "🏆 You WON!",
      html: cardHTML(
        "🏆 Victory!",
        `You defeated ${loser.name}${reason ? ` (${reason})` : ""}`,
        p1,p2,s1,s2,rounds,"#22c55e"
      )
    });

    // LOSER
    await resend.emails.send({
      from: "Game Arena <onboarding@resend.dev>",
      to: [loser.email],
      subject: "💪 Try Again!",
      html: cardHTML(
        "💪 Rematch Again!",
        "Good game! You can win the next match.",
        p1,p2,s1,s2,rounds,"#ef4444"
      )
    });

    console.log("Emails sent via Resend");
  }catch(err){
    console.log("Resend error:", err.message);
  }
}

// =========================
// SOCKET EVENTS
// =========================
io.on('connection',(socket)=>{

  console.log("Connected:",socket.id);

  socket.on('join-room', ({ roomId,name,email })=>{
    socket.join(roomId);
    socket.data.name = name;
    socket.data.email = email;

    if(!rooms[roomId]){
      rooms[roomId]={
        players:[],
        scores:{},
        ready:{},
        choices:{},
        rounds:0,
        names:{},
        emails:{},
        finished:false
      };
    }

    if(!rooms[roomId].players.includes(socket.id)){
      rooms[roomId].players.push(socket.id);
      rooms[roomId].scores[socket.id]=0;
      rooms[roomId].ready[socket.id]=false;
      rooms[roomId].names[socket.id]=name;
      rooms[roomId].emails[socket.id]=email;
    }

    emitPlayers(roomId);
  });

  socket.on('player-ready',({roomId})=>{
    const r = rooms[roomId];
    if(!r) return;

    r.ready[socket.id]=true;
    const allReady = r.players.length>0 && r.players.every(id=>r.ready[id]);
    if(allReady){
      io.to(roomId).emit('start-countdown',{seconds:10});
    }
  });

  socket.on('player-choice',({roomId,choice})=>{
    const r=rooms[roomId];
    if(!r) return;

    r.choices[socket.id]=choice;

    if(Object.keys(r.choices).length===r.players.length){
      const [p1,p2]=r.players;

      const c1=r.choices[p1]??'stone';
      const c2=r.choices[p2]??'stone';

      const n1=r.names[p1];
      const n2=r.names[p2];

      const result=decideWinner({id1:p1,id2:p2,n1,n2,c1,c2});

      if(result.winnerId) r.scores[result.winnerId]++;
      r.rounds++;

      io.to(roomId).emit('round-result',result);

      r.choices={};
      r.ready=r.players.reduce((a,id)=>{a[id]=false;return a;},{}); 
      emitPlayers(roomId);
    }
  });

  socket.on('disconnect', async ()=>{
    for(const rid in rooms){
      const r=rooms[rid];
      if(!r.players.includes(socket.id)) continue;

      if(r.finished){
        r.players = r.players.filter(id=>id!==socket.id);
        if(r.players.length===0) delete rooms[rid];
        continue;
      }

      const ids = Object.keys(r.scores);
      const p1 = ids[0];
      const p2 = ids[1];

      const s1 = r.scores[p1]||0;
      const s2 = r.scores[p2]||0;

      const n1 = r.names[p1];
      const n2 = r.names[p2];
      const e1 = r.emails[p1];
      const e2 = r.emails[p2];

      const leftId = socket.id;
      const otherId = ids.find(id=>id!==leftId);

      let winnerName="Draw";
      if(s1!==s2){
        winnerName = s1>s2 ? n1 : n2;
      }else{
        winnerName = r.names[otherId];
      }

      try{
        await History.create({
          game:"Stone Paper Scissor",
          playerA:{ name:n1,email:e1,score:s1 },
          playerB:{ name:n2,email:e2,score:s2 },
          winner:winnerName,
          reason:"Player left",
          totalRounds:r.rounds
        });
      }catch(err){
        console.log("History save error:", err.message);
      }

      await sendMatchEmails(
        {name:n1,email:e1},
        {name:n2,email:e2},
        s1,s2,r.rounds,"leave"
      );

      r.finished = true;
      r.players = r.players.filter(id=>id!==socket.id);

      if(r.players.length===0){
        delete rooms[rid];
      }
    }
  });

});

// =========================
// HELPERS
// =========================
function emitPlayers(roomId){
  const r=rooms[roomId];
  if(!r) return;

  const players=r.players.map(id=>({
    id,
    name:r.names[id],
    score:r.scores[id]
  }));

  io.to(roomId).emit('update-players',{players});
}

function decideWinner({id1,id2,n1,n2,c1,c2}){
  if(c1===c2) return {text:"Draw",draw:true};

  const win={stone:'scissor',scissor:'paper',paper:'stone'};
  if(win[c1]===c2)
    return {text:`${n1} wins`,winnerId:id1,winnerName:n1};

  return {text:`${n2} wins`,winnerId:id2,winnerName:n2};
}

server.listen(3000,()=>console.log("Server running on 3000"));
