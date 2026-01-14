import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { Mic, Volume2, Radio, Activity } from 'lucide-react'

export const Route = createFileRoute('/')({
  component: WalkieTalkie,
})

type RoomState = {
  currentSpeaker: string | null
}

type AppStatus = 'IDLE' | 'TRANSMITTING' | 'RECEIVING' | 'BUSY'

function WalkieTalkie() {
  // --- STATE ---
  const [status, setStatus] = useState<AppStatus>('IDLE')
  const [roomId, setRoomId] = useState('alpha-channel')
  const [isConnected, setIsConnected] = useState(false)
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  
  // --- REFS ---
  const socketRef = useRef<Socket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextStartTimeRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  // --- LOGGING ---
  const addLog = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 5))
  }

  // --- INITIALIZATION ---
  useEffect(() => {
    // 1. Initialize Audio Context
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    const ctx = new AudioContextClass()
    audioContextRef.current = ctx

    // 2. Initialize Socket
    // Use environment variable if available (Production), otherwise guess local network (Dev)
    const serverUrl = import.meta.env.VITE_SERVER_URL || `http://${window.location.hostname}:3001`
    
    socketRef.current = io(serverUrl)

    const socket = socketRef.current

    socket.on('connect', () => {
      setIsConnected(true)
      addLog('Connected to freq.')
      joinRoom(roomId)
    })

    socket.on('disconnect', () => {
      setIsConnected(false)
      addLog('Signal lost.')
      setStatus('IDLE')
    })

    socket.on('room-state', (state: RoomState) => {
      if (state.currentSpeaker) {
        if (state.currentSpeaker === socket.id) {
            setStatus('TRANSMITTING')
        } else {
            setStatus('BUSY')
            setCurrentSpeaker(state.currentSpeaker)
        }
      } else {
        setStatus('IDLE')
        setCurrentSpeaker(null)
      }
    })

    socket.on('talk-started', ({ userId }: { userId: string }) => {
      if (userId === socket.id) {
        setStatus('TRANSMITTING')
        startRecording()
      } else {
        setStatus('RECEIVING')
        setCurrentSpeaker(userId)
        // Ensure playback context is running
        if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume()
        }
      }
    })

    socket.on('talk-stopped', ({ userId }: { userId: string }) => {
      if (userId === socket.id) {
        setStatus('IDLE')
        stopRecording()
      } else {
        setStatus('IDLE')
        setCurrentSpeaker(null)
        // Reset timing for next burst
        if (audioContextRef.current) {
             nextStartTimeRef.current = audioContextRef.current.currentTime
        }
      }
    })

    socket.on('voice-chunk', async ({ chunk }: { chunk: ArrayBuffer; userId: string }) => {
       playAudioChunk(chunk)
    })

    return () => {
      socket.disconnect()
      stopRecording()
    }
  }, []) // Run once

  // Re-join when room ID changes
  useEffect(() => {
    if (socketRef.current && isConnected) {
        joinRoom(roomId)
    }
  }, [roomId, isConnected])


  const joinRoom = (id: string) => {
    socketRef.current?.emit('join-room', id)
    addLog(`Joined ${id}`)
  }

  // --- AUDIO INPUT (Microphone - RAW PCM) ---
  const startRecording = async () => {
    if (!audioContextRef.current) return
    const ctx = audioContextRef.current

    try {
        await ctx.resume()
        
        // Get Mic
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream

        // Create Source
        const source = ctx.createMediaStreamSource(stream)
        sourceRef.current = source

        // Create Processor (BufferSize 4096 = ~92ms latency at 44.1k)
        // We use ScriptProcessor for simplicity in a single file vs AudioWorklet
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        processor.onaudioprocess = (e) => {
            if (!socketRef.current) return
            
            const inputData = e.inputBuffer.getChannelData(0)
            
            // Convert Float32Array to something sendable (we send raw floats here for quality/ease)
            // Ideally we'd compress this (Opus) but for local LAN raw is fine.
            socketRef.current.emit('voice-chunk', { 
                roomId, 
                chunk: inputData.buffer // ArrayBuffer
            })
        }

        source.connect(processor)
        processor.connect(ctx.destination) // Necessary for the processor to run

    } catch (err) {
        console.error('Mic Error', err)
        addLog('Mic Error!')
    }
  }

  const stopRecording = () => {
    if (sourceRef.current) {
        sourceRef.current.disconnect()
        sourceRef.current = null
    }
    if (processorRef.current) {
        processorRef.current.disconnect()
        processorRef.current = null
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
    }
  }

  // --- AUDIO OUTPUT (Playback - RAW PCM) ---
  const playAudioChunk = (arrayBuffer: ArrayBuffer) => {
    const ctx = audioContextRef.current
    if (!ctx) return

    const float32Data = new Float32Array(arrayBuffer)
    
    const audioBuffer = ctx.createBuffer(1, float32Data.length, ctx.sampleRate)
    audioBuffer.copyToChannel(float32Data, 0)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)

    // Jitter Buffer / Queueing
    const now = ctx.currentTime
    // If we fell behind, reset to now
    if (nextStartTimeRef.current < now) {
        nextStartTimeRef.current = now + 0.05 // 50ms buffer
    }

    source.start(nextStartTimeRef.current)
    nextStartTimeRef.current += audioBuffer.duration
  }


  // --- USER ACTIONS ---
  const handlePTTDown = async () => {
    if (!socketRef.current || !isConnected) return
    
    // Ensure AudioContext is running (browser policy)
    if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume()
    }

    // Request to talk
    socketRef.current.emit('start-talk', roomId)
  }

  const handlePTTUp = () => {
    if (!socketRef.current) return
    socketRef.current.emit('stop-talk', roomId)
  }

  // --- STYLING HELPERS ---
  const getStatusColor = () => {
    switch (status) {
        case 'TRANSMITTING': return 'bg-wt-danger shadow-[0_0_30px_rgba(239,68,68,0.6)]'
        case 'RECEIVING': return 'bg-wt-accent shadow-[0_0_30px_rgba(76,175,80,0.6)]'
        case 'BUSY': return 'bg-yellow-600 opacity-50 cursor-not-allowed'
        default: return 'bg-wt-panel hover:bg-gray-600'
    }
  }

  const getStatusText = () => {
     switch (status) {
        case 'TRANSMITTING': return 'TRANSMITTING...'
        case 'RECEIVING': return `INCOMING: ${currentSpeaker?.slice(0,4)}...`
        case 'BUSY': return 'CHANNEL BUSY'
        default: return 'READY TO TRANSMIT'
     }
  }

  // Unlock audio context on any interaction
  const unlockAudio = () => {
    if (audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume()
    }
  }

  return (
    <div 
        className="min-h-screen flex flex-col items-center justify-center p-4 bg-wt-dark text-wt-text select-none"
        onClick={unlockAudio}
        onTouchStart={unlockAudio}
    >
        
        {/* DEVICE CONTAINER */}
        <div className="w-full max-w-md bg-zinc-800 rounded-3xl p-6 shadow-2xl border-4 border-zinc-700 relative overflow-hidden">
            
            {/* ANTENNA */}
            <div className="absolute -top-12 right-10 w-4 h-24 bg-zinc-900 rounded-full border-2 border-zinc-700 -z-10"></div>

            {/* SPEAKER GRILLE */}
            <div className="mesh-pattern w-full h-32 bg-zinc-900 rounded-xl mb-6 shadow-inner border border-zinc-950 flex items-center justify-center relative">
                <div className={`w-3 h-3 rounded-full absolute top-2 right-2 ${isConnected ? 'bg-green-500' : 'bg-red-500'} animate-pulse`}></div>
                
                {status === 'RECEIVING' && (
                     <Activity className="w-16 h-16 text-wt-accent animate-pulse" />
                )}
                 {status === 'TRANSMITTING' && (
                     <Radio className="w-16 h-16 text-wt-danger animate-pulse" />
                )}
            </div>

            {/* LCD DISPLAY */}
            <div className="bg-[#4a5e4b] p-4 rounded-md mb-6 shadow-inner border-2 border-zinc-600 font-mono text-black">
                <div className="flex justify-between items-center border-b border-black/20 pb-1 mb-2">
                    <span className="text-xs font-bold">CH: {roomId.toUpperCase()}</span>
                    <span className="text-xs">{isConnected ? 'ON' : 'OFF'}</span>
                </div>
                <div className="text-center font-bold text-lg animate-pulse-fast">
                    {getStatusText()}
                </div>
                <div className="mt-2 text-[10px] h-8 overflow-hidden opacity-70">
                    {logs.map((l, i) => <div key={i}>{'> ' + l}</div>)}
                </div>
            </div>

            {/* CONTROLS */}
            <div className="flex flex-col gap-4">
                <div className="flex gap-2">
                    <input 
                        type="text" 
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                        className="bg-zinc-900 text-wt-text border border-zinc-600 p-2 rounded flex-1 uppercase text-sm focus:outline-none focus:border-wt-accent"
                        placeholder="ENTER FREQ"
                    />
                </div>

                {/* PTT BUTTON */}
                <button
                    onMouseDown={handlePTTDown}
                    onMouseUp={handlePTTUp}
                    onMouseLeave={handlePTTUp}
                    onTouchStart={(e) => { e.preventDefault(); handlePTTDown() }}
                    onTouchEnd={(e) => { e.preventDefault(); handlePTTUp() }}
                    disabled={status === 'BUSY' || !isConnected}
                    className={`w-full h-48 rounded-2xl flex flex-col items-center justify-center transition-all transform active:scale-95 border-b-8 border-r-8 border-black/30 ${getStatusColor()}`}
                >
                    <Mic className="w-16 h-16 mb-2 text-white/90" />
                    <span className="font-bold text-2xl tracking-widest text-white/90">PUSH TO TALK</span>
                </button>
            </div>

             {/* BOTTOM DIALS */}
             <div className="mt-8 flex justify-between px-4 opacity-50">
                <Volume2 className="w-6 h-6" />
                <div className="flex gap-1">
                    <div className="w-1 h-6 bg-zinc-600"></div>
                    <div className="w-1 h-6 bg-zinc-600"></div>
                    <div className="w-1 h-6 bg-zinc-600"></div>
                </div>
             </div>

        </div>
        
        <div className="mt-8 text-xs text-zinc-500 text-center">
            SOCKIE-TALKIE MODEL-T1000<br/>
            PRESS AND HOLD TO TRANSMIT
        </div>
    </div>
  )
}
