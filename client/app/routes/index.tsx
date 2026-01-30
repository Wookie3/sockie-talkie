import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { Mic, Radio, Activity } from 'lucide-react'

export const Route = createFileRoute('/')({
  component: WalkieTalkie,
})

type RoomState = {
  currentSpeaker: string | null
  sampleRate?: number // NEW: Store sample rate
}

type AppStatus = 'IDLE' | 'TRANSMITTING' | 'RECEIVING' | 'BUSY'

function WalkieTalkie() {
  // --- STATE ---
  const [status, setStatus] = useState<AppStatus>('IDLE')
  const [roomId, setRoomId] = useState('CHANNEL-A')
  const [isConnected, setIsConnected] = useState(false)
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null)
  const [currentSpeakerUsername, setCurrentSpeakerUsername] = useState<string>('')
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  
  // NEW: Custom Channel State
  const [showCustomInput, setShowCustomInput] = useState(false)
  const [customInput, setCustomInput] = useState('')
  
  // NEW: Username State
  const [username, setUsername] = useState(() => {
    const saved = localStorage.getItem('wt-username')
    return saved || ''
  })
  const [showUsernameModal, setShowUsernameModal] = useState(() => !localStorage.getItem('wt-username'))
  
  // NEW: Room users state
  const [roomUsers, setRoomUsers] = useState<Map<string, string>>(new Map())
  
  // --- REFS ---
  const socketRef = useRef<Socket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextStartTimeRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const activeRoomRef = useRef<string | null>(null)
  const workletInitializedRef = useRef<boolean>(false)
  
  // NEW: Ref to store the incoming speaker's rate
  const speakerSampleRateRef = useRef<number>(16000)
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([])

  // --- LOGGING ---
  const addLog = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 5))
  }

  // --- USERNAME HANDLING ---
  const handleUsernameSubmit = (name: string) => {
    const trimmed = name.trim()
    if (trimmed) {
      setUsername(trimmed)
      localStorage.setItem('wt-username', trimmed)
      setShowUsernameModal(false)
      addLog(`ID: ${trimmed}`)
    }
  }

  // --- INITIALIZATION ---
  useEffect(() => {
    // 1. Initialize Audio Context
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    // Optimize: Use 16kHz for voice to reduce bandwidth/lag
    const ctx = new AudioContextClass({ sampleRate: 16000 })
    audioContextRef.current = ctx

    // Create Master Gain Node (Locked at Max Volume)
    const gainNode = ctx.createGain()
    gainNode.gain.value = 1.0
    gainNode.connect(ctx.destination)
    gainNodeRef.current = gainNode

    // 2. Initialize Socket with reconnection options
    const serverUrl = import.meta.env.VITE_SERVER_URL || `http://${window.location.hostname}:3001`
    
    socketRef.current = io(serverUrl, {
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000
    })

    const socket = socketRef.current

    socket.on('connect', () => {
      setIsConnected(true)
      addLog('Connected to freq.')
      // Send username to server
      if (username) {
        socket.emit('set-username', username)
      }
      // Auto-rejoin current room if we have one
      if (activeRoomRef.current) {
        socket.emit('join-room', activeRoomRef.current)
        addLog(`Rejoined ${activeRoomRef.current}`)
      }
    })

    socket.on('disconnect', () => {
      setIsConnected(false)
      addLog('Signal lost.')
      setStatus('IDLE')
      setRoomUsers(new Map())
      setError('Disconnected')
    })

    socket.io.on('reconnect_attempt', () => {
      addLog('Reconnecting...')
    })

    socket.io.on('reconnect_failed', () => {
      addLog('Reconnect failed')
      setError('Connection failed')
    })

    socket.io.on('error', (err: Error) => {
      console.error('Socket error:', err)
      addLog('Socket error')
    })

    socket.on('room-state', (state: RoomState) => {
      if (state.currentSpeaker) {
        if (state.currentSpeaker === socket.id) {
            setStatus('TRANSMITTING')
        } else {
            setStatus('BUSY')
            setCurrentSpeaker(state.currentSpeaker)
            if (state.sampleRate) speakerSampleRateRef.current = state.sampleRate
        }
      } else {
        setStatus('IDLE')
        setCurrentSpeaker(null)
      }
    })

    socket.on('talk-started', ({ userId, username, sampleRate }: { userId: string, username?: string, sampleRate?: number }) => {
      if (userId === socket.id) {
        setStatus('TRANSMITTING')
        startRecording()
      } else {
        setStatus('RECEIVING')
        setCurrentSpeaker(userId)
        setCurrentSpeakerUsername(username || 'Unknown')
        
        // Update sample rate for playback
        if (sampleRate) speakerSampleRateRef.current = sampleRate

        // Ensure playback context is running
        if (audioContextRef.current?.state === 'suspended') {
            audioContextRef.current.resume()
        }
      }
    })

    socket.on('talk-stopped', ({ userId, username }: { userId: string, username?: string }) => {
      if (userId === socket.id) {
        setStatus('IDLE')
        stopRecording()
      } else {
        setStatus('IDLE')
        setCurrentSpeaker(null)
        setCurrentSpeakerUsername('')
        // Reset timing for next burst
        if (audioContextRef.current) {
             nextStartTimeRef.current = audioContextRef.current.currentTime
        }
      }
    })

    socket.on('user-joined', ({ socketId, username }: { socketId: string, username: string }) => {
      addLog(`${username} joined`)
      setRoomUsers(prev => new Map(prev).set(socketId, username))
    })

    socket.on('user-left', ({ socketId, username }: { socketId: string, username: string }) => {
      addLog(`${username} left`)
      setRoomUsers(prev => {
        const newMap = new Map(prev)
        newMap.delete(socketId)
        return newMap
      })
    })

    socket.on('voice-chunk', async ({ chunk }: { chunk: ArrayBuffer; userId: string }) => {
       playAudioChunk(chunk)
    })

    return () => {
      socket.disconnect()
      stopRecording()
      // Clean up all active audio sources
      activeSourcesRef.current.forEach(source => {
        try {
          source.stop()
          source.disconnect()
        } catch (e) {}
      })
      activeSourcesRef.current = []
      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [])

  const joinRoom = (newRoomId: string) => {
    if (!socketRef.current || !isConnected) return
    
    const prevRoom = activeRoomRef.current
    if (prevRoom && prevRoom !== newRoomId) {
      socketRef.current.emit('leave-room', prevRoom)
    }
    
    // Clear previous room users
    setRoomUsers(new Map())
    
    socketRef.current.emit('join-room', newRoomId, username)
    activeRoomRef.current = newRoomId
    addLog(`Joined ${newRoomId}`)
  }

  // Handle room changes explicitly when socket is connected
  useEffect(() => {
    if (isConnected && roomId) {
      joinRoom(roomId)
    }
  }, [isConnected])

  // Handle initial room join on first render
  useEffect(() => {
    if (isConnected && !activeRoomRef.current && roomId) {
      joinRoom(roomId)
    }
  }, [])


  // --- AUDIO INPUT (Microphone - RAW PCM) ---
  const startRecording = async () => {
    if (!audioContextRef.current) return
    const ctx = audioContextRef.current

    try {
        await ctx.resume()
        
        // Load worklet module (only once)
        if (!workletInitializedRef.current) {
            await ctx.audioWorklet.addModule('/worklets/audio-processor.js')
            workletInitializedRef.current = true
        }
        
        // Get Mic - Request 16kHz to match context
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            } 
        })
        streamRef.current = stream

        // Create Source
        const source = ctx.createMediaStreamSource(stream)
        sourceRef.current = source

        // Create AudioWorkletNode
        const processor = new AudioWorkletNode(ctx, 'audio-processor')
        processorRef.current = processor

        // Handle messages from worklet
        processor.port.onmessage = (event) => {
            if (!socketRef.current || event.data.type !== 'audioData') return
            
            const currentRoom = activeRoomRef.current || roomId
            
            socketRef.current.emit('voice-chunk', { 
                roomId: currentRoom, 
                chunk: event.data.buffer 
            })
        }

        source.connect(processor)
        processor.connect(ctx.destination) 
        setError(null)
        addLog('Mic active')

    } catch (err) {
        console.error('Mic Error', err)
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        let userMessage = 'Mic Error'
        
        if (errorMsg.includes('Permission denied') || errorMsg.includes('NotAllowedError')) {
            userMessage = 'Mic permission denied'
        } else if (errorMsg.includes('NotFoundError') || errorMsg.includes('not found')) {
            userMessage = 'No mic detected'
        } else if (errorMsg.includes('NotReadableError')) {
            userMessage = 'Mic in use'
        }
        
        setError(userMessage)
        addLog(userMessage)
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
    
    const playbackRate = speakerSampleRateRef.current || 16000
    
    const audioBuffer = ctx.createBuffer(1, float32Data.length, playbackRate)
    audioBuffer.copyToChannel(float32Data, 0)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    
    // Connect to Master Gain instead of direct destination
    if (gainNodeRef.current) {
        source.connect(gainNodeRef.current)
    } else {
        source.connect(ctx.destination)
    }

    // Track this source for cleanup
    activeSourcesRef.current.push(source)

    // Remove from tracking after playback completes
    source.onended = () => {
      const index = activeSourcesRef.current.indexOf(source)
      if (index > -1) {
        activeSourcesRef.current.splice(index, 1)
      }
      source.disconnect()
    }

    // Jitter Buffer Logic
    const now = ctx.currentTime
    
    // Improved drift correction
    // If we are too far behind (> 0.3s), jump ahead to avoid "lag buildup"
    if (nextStartTimeRef.current < now || nextStartTimeRef.current > now + 0.3) {
        nextStartTimeRef.current = now + 0.05 // Reset buffer to 50ms
    }

    source.start(nextStartTimeRef.current)
    nextStartTimeRef.current += audioBuffer.duration
  }


  // --- USER ACTIONS ---
  const handlePTTDown = async () => {
    if (!socketRef.current || !isConnected) return
    
    if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume()
    }

    // NEW: Send our Sample Rate so others play it correctly
    const mySampleRate = audioContextRef.current?.sampleRate || 44100
    socketRef.current.emit('start-talk', { roomId, sampleRate: mySampleRate })
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
        case 'RECEIVING': return `INCOMING: ${currentSpeakerUsername?.slice(0,12) || 'Unknown'}`
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

  // Clear error state
  const clearError = () => {
    setError(null)
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
                <div 
                    onClick={error ? clearError : undefined}
                    className={`text-center font-bold text-lg cursor-pointer ${error ? 'text-red-700' : 'animate-pulse-fast'}`}
                    title={error ? "Click to dismiss" : ""}
                >
                    {error || getStatusText()}
                </div>
                <div className="mt-2 text-[10px] h-8 overflow-hidden opacity-70">
                    {logs.map((l, i) => <div key={i}>{'> ' + l}</div>)}
                </div>
            </div>

            {/* ROOM ROSTER */}
            {roomUsers.size > 0 && (
                <div className="bg-zinc-900/50 rounded-lg p-2 mb-4">
                    <div className="text-[10px] text-zinc-500 mb-1 font-bold uppercase tracking-wider">
                        CHANNEL USERS ({roomUsers.size})
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {Array.from(roomUsers.entries()).map(([socketId, userName]) => (
                            <div 
                                key={socketId}
                                className={`px-2 py-1 rounded text-[10px] font-mono ${
                                    currentSpeaker === socketId 
                                        ? 'bg-wt-accent text-zinc-900 font-bold' 
                                        : 'bg-zinc-700 text-zinc-300'
                                }`}
                            >
                                {userName}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* CONTROLS */}
            <div className="flex flex-col gap-4">
                <div className="flex gap-2 justify-between bg-zinc-900/50 p-2 rounded-lg">
                    {['A', 'B', 'C'].map((ch) => (
                        <button
                            key={ch}
                            onClick={() => {
                                const newRoom = `CHANNEL-${ch}`
                                setRoomId(newRoom)
                                setShowCustomInput(false)
                                if (isConnected) {
                                    joinRoom(newRoom)
                                }
                            }}
                            className={`
                                flex-1 py-3 rounded-md font-bold text-lg transition-all
                                ${roomId === `CHANNEL-${ch}` 
                                    ? 'bg-wt-accent text-zinc-900 shadow-[0_0_15px_rgba(76,175,80,0.4)] transform scale-105' 
                                    : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-white'}
                            `}
                        >
                            {ch}
                        </button>
                    ))}
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

             {/* CUSTOM CHANNEL */}
             <div className="mt-8 px-4 h-10">
                {!showCustomInput ? (
                    <button 
                        onClick={() => setShowCustomInput(true)}
                        className="w-full h-full py-2 bg-zinc-700/50 rounded border border-zinc-600 text-xs font-bold text-zinc-400 hover:text-white hover:bg-zinc-600 hover:border-zinc-500 transition-all uppercase tracking-wider"
                    >
                        Custom Channel
                    </button>
                ) : (
                    <div className="flex gap-2 h-full animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <input 
                            type="text" 
                            className="flex-1 bg-zinc-900 border border-zinc-500 rounded px-3 text-sm uppercase text-white placeholder-zinc-600 focus:outline-none focus:border-wt-accent focus:ring-1 focus:ring-wt-accent transition-all"
                            placeholder="ENTER NAME..."
                            value={customInput}
                            onChange={(e) => setCustomInput(e.target.value.toUpperCase())}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && customInput.trim()) {
                                    setRoomId(customInput.trim())
                                    if (isConnected) {
                                        joinRoom(customInput.trim())
                                    }
                                }
                            }}
                            autoFocus
                        />
                         <button 
                             onClick={() => {
                                 if (customInput.trim()) {
                                     setRoomId(customInput.trim())
                                     if (isConnected) {
                                         joinRoom(customInput.trim())
                                     }
                                 }
                             }}
                             className="bg-wt-accent px-4 rounded text-zinc-900 font-bold text-xs hover:brightness-110 active:scale-95 transition-all"
                         >
                             SET
                         </button>
                    </div>
                )}
             </div>

        </div>
        
        <div className="mt-8 text-xs text-zinc-500 text-center">
            SOCKIE-TALKIE MODEL-T1000<br/>
            PRESS AND HOLD TO TRANSMIT
        </div>
        
        {/* USERNAME MODAL */}
        {showUsernameModal && (
            <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
                <div className="bg-zinc-800 rounded-2xl p-8 max-w-md w-full border-4 border-zinc-700 shadow-2xl">
                    <h2 className="text-2xl font-bold text-center text-wt-accent mb-2">IDENTIFY YOURSELF</h2>
                    <p className="text-center text-zinc-400 mb-6 text-sm">Choose your callsign for communication</p>
                    
                    <input 
                        type="text" 
                        className="w-full bg-zinc-900 border-2 border-zinc-600 rounded-lg px-4 py-3 text-lg text-white placeholder-zinc-500 focus:outline-none focus:border-wt-accent focus:ring-2 focus:ring-wt-accent transition-all mb-4"
                        placeholder="ENTER CALLSIGN..."
                        value={username}
                        onChange={(e) => setUsername(e.target.value.toUpperCase())}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && username.trim()) {
                                handleUsernameSubmit(username)
                            }
                        }}
                        autoFocus
                        maxLength={15}
                    />
                    
                    <button 
                        onClick={() => handleUsernameSubmit(username)}
                        disabled={!username.trim()}
                        className="w-full bg-wt-accent text-zinc-900 font-bold text-xl py-3 rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transition-all"
                    >
                        SET CALLSIGN
                    </button>
                </div>
            </div>
        )}
    </div>
  )
}