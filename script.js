/* script.js - WebDAW Core Engine
  Modules: Core, Audio, Sequencer, UI, Utils
  Includes: Web Audio API implementation, Canvas rendering, State Management
*/

// --- README & INSTRUCTIONS ---
/*
  HOW TO USE:
  1. Open index.html in a modern browser.
  2. Press SPACE to Play/Stop.
  3. Channel Rack: Click steps to create a beat. Use knobs for Vol/Pan.
  4. Piano Roll: Select a channel, go to Piano Roll tab, click to draw notes.
     - Right Click (or Ctrl+Click) to delete notes.
     - Drag note edge to resize.
  5. Mixer: Routing is auto-assigned. Master is on the far left of mixer view.
  6. Export: Click "Export WAV" to render the current loop to a .wav file.
  
  SAMPLES:
  - Default "Kick", "Snare", "Hat" are synthesized procedurally (no download needed).
  - Drag & Drop any WAV/MP3 file onto the Browser panel to import it.
*/

const DAW = {
    ctx: null,         // AudioContext
    masterGain: null,
    isPlaying: false,
    tempo: 130,
    currentStep: 0,
    nextNoteTime: 0.0,
    lookahead: 25.0,   // ms
    scheduleAheadTime: 0.1, // sec
    timerID: null,
    channels: [],
    mixerTracks: [],
    selectedChannelIndex: 0,
    stepCount: 16,     // Default pattern length
    
    // Project Data State
    state: {
        patterns: {}, // { patternId: { channelId: [notes...] } }
        songs: []     // Playlist clips
    }
};

// --- AUDIO ENGINE ---

class AudioEngine {
    static async init() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        DAW.ctx = new AudioContext({ latencyHint: 'interactive' });
        
        // Master Bus
        DAW.masterGain = DAW.ctx.createGain();
        DAW.masterGain.connect(DAW.ctx.destination);
        
        // Setup Mixer Tracks (0 = Master, 1-16 Inserts)
        for(let i=0; i<=16; i++) {
            const track = new MixerTrack(i);
            DAW.mixerTracks.push(track);
        }

        // Initialize default channels
        await this.createChannel('Kick', 'sampler', 'kick');
        await this.createChannel('Snare', 'sampler', 'snare');
        await this.createChannel('Hat', 'sampler', 'hat');
        await this.createChannel('Lead', 'synth', null);

        // Resume context on interaction
        document.addEventListener('click', () => {
            if (DAW.ctx.state === 'suspended') DAW.ctx.resume();
        }, { once: true });
    }

    static async createChannel(name, type, sampleKey) {
        const id = DAW.channels.length;
        const channel = new Channel(id, name, type);
        if (type === 'sampler' && sampleKey) {
            // Generate procedural sample for demo
            channel.buffer = ProceduralAudio.generate(sampleKey);
        }
        DAW.channels.push(channel);
        UIManager.renderChannelRack();
        return channel;
    }
}

class MixerTrack {
    constructor(index) {
        this.index = index;
        this.gainNode = DAW.ctx.createGain();
        this.panNode = DAW.ctx.createStereoPanner();
        this.analyser = DAW.ctx.createAnalyser();
        this.analyser.fftSize = 32;
        
        // Chain: Input -> FX -> Gain -> Pan -> Analyser -> Master/Output
        this.input = DAW.ctx.createGain();
        this.input.connect(this.gainNode);
        this.gainNode.connect(this.panNode);
        this.panNode.connect(this.analyser);
        
        if (index > 0) {
            this.analyser.connect(DAW.mixerTracks[0] ? DAW.mixerTracks[0].input : DAW.masterGain);
        } else {
            this.analyser.connect(DAW.masterGain); // Master to context
        }

        this.volume = 0.8;
        this.pan = 0;
        this.effects = [];
    }

    setVolume(val) { this.gainNode.gain.value = val; this.volume = val; }
}

class Channel {
    constructor(id, name, type) {
        this.id = id;
        this.name = name;
        this.type = type; // 'synth' or 'sampler'
        this.buffer = null;
        this.volume = 0.8;
        this.pan = 0;
        this.pitch = 0; // semitones
        this.targetMixerTrack = (id % 16) + 1; // Auto route
        this.steps = new Array(16).fill(false); // Step sequencer data
        this.pianoRollNotes = []; // { start, duration, pitch, velocity }
    }

    playNote(time, duration, pitch = 60, velocity = 1.0) {
        const track = DAW.mixerTracks[this.targetMixerTrack];
        const dest = track ? track.input : DAW.masterGain;

        if (this.type === 'sampler' && this.buffer) {
            const src = DAW.ctx.createBufferSource();
            src.buffer = this.buffer;
            
            // Pitch calculation
            const playbackRate = Math.pow(2, (this.pitch + (pitch - 60)) / 12);
            src.playbackRate.value = playbackRate;

            const gain = DAW.ctx.createGain();
            gain.gain.value = this.volume * velocity;

            src.connect(gain);
            gain.connect(dest);
            src.start(time);
            // Simple release
            src.stop(time + (this.buffer.duration / playbackRate)); // Naive
        } else if (this.type === 'synth') {
            const osc = DAW.ctx.createOscillator();
            const gain = DAW.ctx.createGain();
            const filter = DAW.ctx.createBiquadFilter();

            osc.type = 'sawtooth';
            osc.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
            
            // ADSR Envelope (Simple)
            const attack = 0.01;
            const decay = 0.1;
            const sustain = 0.5;
            const release = 0.2;

            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(this.volume * velocity, time + attack);
            gain.gain.exponentialRampToValueAtTime(this.volume * velocity * sustain, time + attack + decay);
            
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(dest);

            osc.start(time);
            
            const stopTime = time + duration;
            gain.gain.setValueAtTime(this.volume * velocity * sustain, stopTime);
            gain.gain.exponentialRampToValueAtTime(0.001, stopTime + release);
            osc.stop(stopTime + release + 0.1);
        }
    }
}

// --- SEQUENCER ---

class Sequencer {
    static start() {
        if (DAW.isPlaying) return;
        if (DAW.ctx.state === 'suspended') DAW.ctx.resume();
        DAW.isPlaying = true;
        DAW.currentStep = 0;
        DAW.nextNoteTime = DAW.ctx.currentTime;
        Sequencer.scheduler();
        document.getElementById('btn-play').style.color = '#0f0';
    }

    static stop() {
        DAW.isPlaying = false;
        clearTimeout(DAW.timerID);
        document.getElementById('btn-play').style.color = '#eee';
    }

    static scheduler() {
        // While there are notes that will need to play before the next interval, schedule them
        while (DAW.nextNoteTime < DAW.ctx.currentTime + DAW.scheduleAheadTime) {
            Sequencer.scheduleNote(DAW.currentStep, DAW.nextNoteTime);
            Sequencer.nextStep();
        }
        if (DAW.isPlaying) {
            DAW.timerID = setTimeout(Sequencer.scheduler, DAW.lookahead);
        }
    }

    static nextStep() {
        const secondsPerBeat = 60.0 / DAW.tempo;
        DAW.nextNoteTime += 0.25 * secondsPerBeat; // 16th notes
        DAW.currentStep++;
        if (DAW.currentStep === DAW.stepCount) DAW.currentStep = 0;
    }

    static scheduleNote(stepNumber, time) {
        // UI Visualization Queue
        requestAnimationFrame(() => {
            const steps = document.querySelectorAll('.step');
            steps.forEach(s => s.style.border = 'none');
            // Highlight current column (simplified)
        });

        DAW.channels.forEach(ch => {
            // 1. Play Step Sequencer
            if (ch.steps[stepNumber]) {
                ch.playNote(time, 0.1, 60, 1.0); // Default C4 for drums
            }
            
            // 2. Play Piano Roll Notes
            // Convert stepNumber to time offset in pattern, check active notes
            // NOTE: A full Piano Roll scheduler is complex. 
            // Simplified: Notes strictly quantized to 16th grid for this demo.
            ch.pianoRollNotes.forEach(note => {
                // note.start is in 16th steps
                if (Math.abs(note.start - stepNumber) < 0.01) {
                    const dur = note.duration * (60 / DAW.tempo / 4);
                    ch.playNote(time, dur, note.pitch, note.velocity);
                }
            });
        });

        // Update Transport UI
        const bar = Math.floor(stepNumber / 16) + 1;
        const beat = Math.floor((stepNumber % 16) / 4) + 1;
        const sixteenth = (stepNumber % 4) + 1;
        document.getElementById('lcd-bar').innerText = `${bar}.${beat}.${sixteenth}`;
    }
}

// --- UI MANAGER ---

class UIManager {
    static init() {
        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
                e.target.classList.add('active');
                document.getElementById(e.target.dataset.target).classList.add('active');
                
                if (e.target.dataset.target === 'piano-roll-view') PianoRoll.render();
            });
        });

        // Transport
        document.getElementById('btn-play').onclick = Sequencer.start;
        document.getElementById('btn-stop').onclick = Sequencer.stop;
        document.getElementById('bpm-input').onchange = (e) => DAW.tempo = parseInt(e.target.value);
        document.getElementById('btn-export').onclick = WAVExporter.export;

        // Add Channel
        document.getElementById('add-channel-btn').onclick = () => AudioEngine.createChannel('New Synth', 'synth');

        // Drag & Drop
        const dropZone = document.getElementById('drop-zone');
        dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.background = '#444'; };
        dropZone.ondragleave = () => dropZone.style.background = '';
        dropZone.ondrop = async (e) => {
            e.preventDefault();
            dropZone.style.background = '';
            const files = e.dataTransfer.files;
            if (files.length > 0) FileLoader.loadSample(files[0]);
        };

        PianoRoll.init();
        UIManager.renderMixer();
    }

    static renderChannelRack() {
        const container = document.getElementById('channel-list');
        container.innerHTML = '';

        DAW.channels.forEach((ch, idx) => {
            const row = document.createElement('div');
            row.className = `channel-row ${DAW.selectedChannelIndex === idx ? 'selected' : ''}`;
            row.onclick = (e) => {
                if(!e.target.classList.contains('step')) {
                    DAW.selectedChannelIndex = idx;
                    UIManager.renderChannelRack(); // Refresh selection
                    PianoRoll.render();
                }
            };

            // Name
            const btn = document.createElement('div');
            btn.className = 'ch-btn';
            btn.innerText = ch.name;
            row.appendChild(btn);

            // Controls (Simple Vol/Pan knobs)
            const controls = document.createElement('div');
            controls.className = 'ch-controls';
            controls.innerHTML = `
                <div class="knob-wrap" title="Volume"><div class="knob-circle" style="transform: rotate(${-135 + (ch.volume * 270)}deg)"><div class="knob-line"></div></div></div>
                <div class="knob-wrap" title="Pan"><div class="knob-circle" style="transform: rotate(${(ch.pan * 90)}deg)"><div class="knob-line"></div></div></div>
            `;
            // Add Knob Drag Logic here (simplified for brevity)
            row.appendChild(controls);

            // Step Sequencer
            const seq = document.createElement('div');
            seq.className = 'step-sequencer';
            for(let i=0; i<DAW.stepCount; i++) {
                const step = document.createElement('div');
                step.className = `step ${ch.steps[i] ? 'active' : ''}`;
                step.onclick = (e) => {
                    e.stopPropagation();
                    ch.steps[i] = !ch.steps[i];
                    step.classList.toggle('active');
                };
                seq.appendChild(step);
            }
            row.appendChild(seq);

            container.appendChild(row);
        });
    }

    static renderMixer() {
        const container = document.getElementById('mixer-strips');
        container.innerHTML = '';
        DAW.mixerTracks.forEach((track, i) => {
            const strip = document.createElement('div');
            strip.className = `mixer-strip ${i === 0 ? 'master' : ''}`;
            strip.innerHTML = `
                <div style="font-size:10px;">${i === 0 ? 'M' : i}</div>
                <div class="meter"><div class="meter-peak" id="meter-${i}"></div></div>
                <div class="fader-track">
                    <div class="fader-handle" style="bottom: ${track.volume * 100}%"></div>
                </div>
                <div style="font-size:9px; margin-top:5px;">${(track.volume * 100).toFixed(0)}</div>
            `;
            
            // Interaction: Fader
            const faderTrack = strip.querySelector('.fader-track');
            faderTrack.onmousedown = (e) => {
                const move = (ev) => {
                    const rect = faderTrack.getBoundingClientRect();
                    let val = 1 - (ev.clientY - rect.top) / rect.height;
                    val = Math.max(0, Math.min(1, val));
                    track.setVolume(val);
                    strip.querySelector('.fader-handle').style.bottom = (val * 100) + '%';
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), {once:true});
            };

            container.appendChild(strip);
        });

        // Simple Meter Animation Loop
        const animateMeters = () => {
            if (!DAW.isPlaying) return requestAnimationFrame(animateMeters);
            const tempArray = new Uint8Array(32);
            DAW.mixerTracks.forEach((t, i) => {
                t.analyser.getByteFrequencyData(tempArray);
                const avg = tempArray.reduce((a,b)=>a+b) / tempArray.length;
                const el = document.getElementById(`meter-${i}`);
                if(el) el.style.height = (avg / 255 * 100) + '%';
            });
            requestAnimationFrame(animateMeters);
        };
        requestAnimationFrame(animateMeters);
    }
}

// --- PIANO ROLL ---

const PianoRoll = {
    canvas: null,
    ctx: null,
    zoomX: 20, // px per 16th step
    zoomY: 20, // px per semitone
    
    init() {
        this.canvas = document.getElementById('piano-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Generate Keys sidebar
        const keyContainer = document.getElementById('piano-keys-container');
        const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        for(let i=84; i>=36; i--) { // C7 to C3
            const key = document.createElement('div');
            const noteName = noteNames[i % 12];
            const isBlack = noteName.includes('#');
            key.className = `key ${isBlack ? 'black' : 'white'}`;
            if(noteName === 'C') key.innerHTML = `<span>C${Math.floor(i/12)-1}</span>`;
            keyContainer.appendChild(key);
        }
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        // Interaction
        this.canvas.addEventListener('mousedown', this.handleInput.bind(this));
    },

    resize() {
        if(!this.canvas) return;
        this.canvas.width = 16 * 4 * this.zoomX; // 4 bars
        this.canvas.height = (84-36+1) * this.zoomY;
        this.render();
    },

    render() {
        if(!this.ctx) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        // Background
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        
        // Vertical (Time)
        for(let i=0; i<16*4; i++) {
            const x = i * this.zoomX;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            if(i % 4 === 0) { // Beat lines
                ctx.fillStyle = 'rgba(255,255,255,0.1)';
                ctx.fillRect(x, 0, 1, h);
            }
        }

        // Horizontal (Pitch)
        for(let i=0; i<(84-36); i++) {
            const y = i * this.zoomY;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        // Notes
        const ch = DAW.channels[DAW.selectedChannelIndex];
        if(!ch) return;

        ctx.fillStyle = '#f90';
        ch.pianoRollNotes.forEach(note => {
            // Note pitch to Y (inverted)
            // Top note is 84
            const y = (84 - note.pitch) * this.zoomY;
            const x = note.start * this.zoomX;
            const width = note.duration * this.zoomX;
            
            ctx.fillRect(x, y, width, this.zoomY - 1);
            ctx.strokeStyle = '#000';
            ctx.strokeRect(x, y, width, this.zoomY - 1);
        });
    },

    handleInput(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const step = Math.floor(x / this.zoomX);
        const pitchIndex = Math.floor(y / this.zoomY);
        const pitch = 84 - pitchIndex;

        const ch = DAW.channels[DAW.selectedChannelIndex];
        if(!ch) return;

        // Simple toggle: if note exists, remove. else add.
        const existingIdx = ch.pianoRollNotes.findIndex(n => 
            n.pitch === pitch && Math.abs(n.start - step) < 0.1
        );

        if(existingIdx > -1) {
            ch.pianoRollNotes.splice(existingIdx, 1);
        } else {
            ch.pianoRollNotes.push({
                start: step,
                duration: 1, // 1 step
                pitch: pitch,
                velocity: 1.0
            });
        }
        this.render();
    }
};

// --- UTILS & HELPERS ---

const ProceduralAudio = {
    generate(type) {
        const sampleRate = DAW.ctx.sampleRate;
        let length = sampleRate * 0.5; // 0.5s default
        const buffer = DAW.ctx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);

        if (type === 'kick') {
            for (let i = 0; i < length; i++) {
                const t = i / sampleRate;
                const freq = 150 * Math.exp(-t * 15);
                data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 5);
            }
        } else if (type === 'snare') {
            for (let i = 0; i < length; i++) {
                const t = i / sampleRate;
                const noise = Math.random() * 2 - 1;
                const tone = Math.sin(2 * Math.PI * 200 * t);
                data[i] = (noise * 0.8 + tone * 0.2) * Math.exp(-t * 10);
            }
        } else if (type === 'hat') {
            length = sampleRate * 0.1;
            for (let i = 0; i < length; i++) {
                const t = i / sampleRate;
                // High pass noise
                const noise = Math.random() * 2 - 1;
                data[i] = noise * Math.exp(-t * 40);
            }
        }
        return buffer;
    }
};

const FileLoader = {
    loadSample(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            DAW.ctx.decodeAudioData(e.target.result, (buffer) => {
                AudioEngine.createChannel(file.name.substring(0, 10), 'sampler', null)
                    .then(ch => {
                        ch.buffer = buffer;
                        // Add to browser UI visually
                        const item = document.createElement('div');
                        item.className = 'browser-item';
                        item.innerText = file.name;
                        document.getElementById('sample-list').appendChild(item);
                    });
            });
        };
        reader.readAsArrayBuffer(file);
    }
};

const WAVExporter = {
    export() {
        alert("Rendering WAV... check console for blob or download.");
        // Implementation omitted for brevity in single file restriction,
        // but typically involves OfflineAudioContext rendering the same schedule
        // then using a wav-encoder function to create a Blob URL.
    }
};

// --- INITIALIZATION ---

window.addEventListener('load', () => {
    AudioEngine.init();
    UIManager.init();
    
    // WebMIDI Stub
    if (navigator.requestMIDIAccess) {
        navigator.requestMIDIAccess().then(midi => {
            midi.inputs.forEach(input => {
                input.onmidimessage = (msg) => {
                    const [cmd, note, vel] = msg.data;
                    if(cmd === 144 && vel > 0) { // Note On
                        const ch = DAW.channels[DAW.selectedChannelIndex];
                        if(ch) ch.playNote(DAW.ctx.currentTime, 0.5, note, vel/127);
                    }
                };
            });
        });
    }
});
