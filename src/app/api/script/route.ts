import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://api.novita.ai/v3/openai",
  apiKey: process.env.NOVITA_API_KEY as string,
});

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY as string;
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

// Define a type for the voice keys
type VoiceKey = keyof typeof PERSONALITY_VOICES;

// Voice assignments for different personality types
const PERSONALITY_VOICES = {
  // Male voices
  "male_confident": "AZnzlk1XvdvUeBnXmlld", // Domi
  "male_deep": "TxGEqnHWrfWFTfGW9XjX",      // Josh
  "male_friendly": "ErXwobaYiN019PkySvjV",    // Antoni
  
  // Female voices
  "female_clear": "21m00Tcm4TlvDq8ikWAM",    // Rachel
  "female_young": "EXAVITQu4vr4xnSDxMaL",    // Bella
  "female_expressive": "MF3mGyEYCl7XYWbV9V6O", // Elli
  
  // Default fallbacks
  "default_male": "AZnzlk1XvdvUeBnXmlld",
  "default_female": "21m00Tcm4TlvDq8ikWAM"
} as const; 

interface PodcastRequestBody {
  personality1: string;
  personality2: string;
  podcastTopic: string;
  voice1Type?: VoiceKey;
  voice2Type?: VoiceKey;
}

interface ScriptSegment {
  speaker: string;
  text: string;
  isPersonality1: boolean;
}

interface AudioSegment extends ScriptSegment {
  segmentIndex: number;
  audioBase64: string | null;
  voiceId: string | null;
  duration?: number;
  error?: string;
}

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  try {
    // Validate environment variables
    if (!process.env.NOVITA_API_KEY) {
      console.error('NOVITA_API_KEY is not configured.');
      return NextResponse.json(
        { error: "Server configuration error: NOVITA_API_KEY missing." }, 
        { status: 500 }
      );
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      console.error('ELEVENLABS_API_KEY is not configured.');
      return NextResponse.json(
        { error: "Server configuration error: ELEVENLABS_API_KEY missing." }, 
        { status: 500 }
      );
    }

    // Parse and validate request body
    let requestBody: PodcastRequestBody;
    try {
      requestBody = await req.json();
    } catch (error) {
      return NextResponse.json(
        { error: "Invalid JSON in request body" }, 
        { status: 400 }
      );
    }

    const { 
      personality1, 
      personality2, 
      podcastTopic, 
      voice1Type = "male_confident", 
      voice2Type = "female_clear" 
    } = requestBody;

    if (!personality1 || !personality2 || !podcastTopic) {
      return NextResponse.json(
        { error: "personality1, personality2, and podcastTopic are required" }, 
        { status: 400 }
      );
    }

    console.log("Starting podcast generation...");

    // Step 1: Generate the script
    const script = await generateScript(personality1, personality2, podcastTopic);
    
    // Step 2: Parse script into segments
    const segments: ScriptSegment[] = parseScript(script, personality1, personality2);
    
    // Step 3: Generate audio for each segment
    const audioSegments: AudioSegment[] = await generateAudioSegments(segments, voice1Type, voice2Type);
    
    return NextResponse.json({
      success: true,
      script: script,
      segments: segments,
      audioSegments: audioSegments,
      personalities: { personality1, personality2 },
      topic: podcastTopic,
      totalSegments: audioSegments.length
    });

  } catch (error) {
    console.error('Podcast generation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to generate podcast';
    return NextResponse.json(
      { error: errorMessage }, 
      { status: 500 }
    );
  }
};

async function generateScript(personality1: string, personality2: string, podcastTopic: string): Promise<string> {
  try {
    const prompt = `Create a *very short* and natural podcast conversation between ${personality1} and ${personality2} about "${podcastTopic}".

This is a test run while the podcast tool is still in development, so keep the dialogue minimal.

Format the script exactly like this:
[SPEAKER: ${personality1}]: [Their dialogue here]
[SPEAKER: ${personality2}]: [Their response here]

CRITICAL REQUIREMENTS:
- MAXIMUM LENGTH: Keep the script under 30 seconds of audio (around 100-150 words total)
- This is a test version — keep it very short
- NO asterisks (*) or action descriptions — only spoken dialogue
- NO stage directions like *laughs* or *pauses* — just natural speech
- Each speaker gets 2-3 short exchanges maximum
- Use distinct speech styles matching their public personalities
- Include a light intro and quick conclusion
- Equal speaking time for both
- Make it sound like a real, relaxed podcast moment

Start the script now:`;

    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "google/gemma-3-27b-it",
      stream: false,
      response_format: { type: "text" },
      max_tokens: 500,
      temperature: 0.7
    });

    let generatedScript = completion.choices[0]?.message?.content;
    if (!generatedScript) {
      throw new Error("No script generated from AI");
    }

    // 🚫 Remove any action descriptions like *laughs* or *sigh*
    generatedScript = generatedScript.replace(/\*[^*]+\*/g, '');

    console.log("Cleaned Script:", generatedScript);
    return generatedScript.trim();
  } catch (error) {
    console.error('Error generating script:', error);
    throw new Error(`Failed to generate script: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}


function parseScript(script: string, personality1: string, personality2: string): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  const lines = script.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    const match = line.match(/\[SPEAKER:\s*([^\]]+)\]:\s*(.+)/);
    if (match) {
      const speaker = match[1].trim();
      const text = match[2].trim();
      
      // Clean up text - remove extra quotation marks, etc.
      const cleanText = text.replace(/^["']|["']$/g, '').trim();
      
      if (cleanText.length > 0) {
        segments.push({
          speaker: speaker,
          text: cleanText,
          isPersonality1: speaker === personality1
        });
      }
    }
  }
  
  if (segments.length === 0) {
    console.warn('No segments parsed from script, creating fallback segments');
    // Create fallback segments if parsing fails
    segments.push(
      {
        speaker: personality1,
        text: `Welcome to our discussion about ${script.substring(0, 100)}...`,
        isPersonality1: true
      },
      {
        speaker: personality2,
        text: "Thank you for having me. This is indeed an interesting topic.",
        isPersonality1: false
      }
    );
  }
  
  return segments;
}

async function generateAudioSegments(segments: ScriptSegment[], voice1Type: VoiceKey, voice2Type: VoiceKey): Promise<AudioSegment[]> {
  const audioSegments: AudioSegment[] = [];
  let quotaExceeded = false;
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    let currentVoiceId: string | null = null;
    
    try {
      // If quota already exceeded, don't attempt ElevenLabs API calls
      if (quotaExceeded) {
        throw new Error('ElevenLabs quota exceeded, using fallback');
      }
      
      // Choose voice based on which personality is speaking
      currentVoiceId = segment.isPersonality1 
        ? PERSONALITY_VOICES[voice1Type] || PERSONALITY_VOICES.default_male
        : PERSONALITY_VOICES[voice2Type] || PERSONALITY_VOICES.default_female;
      
      console.log(`Generating audio for segment ${i + 1}/${segments.length}: ${segment.speaker}`);
      
      // Generate audio for this segment
      const audioData = await generateSingleAudio(segment.text, currentVoiceId);
      
      audioSegments.push({
        ...segment,
        segmentIndex: i,
        audioBase64: audioData,
        voiceId: currentVoiceId,
        duration: Math.ceil(segment.text.length / 10)
      });
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      console.error(`Error generating audio for segment ${i}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during audio generation';
      
      // Check if this is a quota exceeded error
      if (error instanceof Error && errorMessage.includes('quota_exceeded')) {
        console.log('ElevenLabs quota exceeded, switching to fallback for remaining segments');
        quotaExceeded = true;
      }
      
      // Generate a fallback audio or use a placeholder
      let fallbackAudio = null;
      try {
        fallbackAudio = await generateFallbackAudio(segment.text);
      } catch (fallbackError) {
        console.error('Fallback audio generation also failed:', fallbackError);
      }
      
      // Add a placeholder or fallback for failed segments
      audioSegments.push({
        ...segment,
        segmentIndex: i,
        audioBase64: fallbackAudio,
        error: errorMessage,
        voiceId: currentVoiceId
      });
    }
  }
  
  return audioSegments;
}

// Enhanced fallback audio generation
async function generateFallbackAudio(text: string): Promise<string | null> {
  try {
    // Create a simple audio tone as fallback
    const sampleRate = 22050;
    const duration = Math.min(text.length / 10, 5); // Max 5 seconds
    const samples = Math.floor(sampleRate * duration);
    
    // Create a simple sine wave
    const frequency = 440; // A4 note
    const amplitude = 0.1;
    
    const audioData = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      audioData[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
    }
    
    // Convert to WAV format (simplified)
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples * 2, true);
    
    // Convert float samples to 16-bit PCM
    let offset = 44;
    for (let i = 0; i < samples; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
    
    // Convert to base64
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    
    return btoa(binary);
  } catch (error) {
    console.error('Error generating fallback audio:', error);
    return null;
  }
}

async function generateSingleAudio(text: string, voiceId: string): Promise<string> {
  if (!text || text.trim() === '') {
    throw new Error('Empty text provided for audio generation');
  }

  if (!voiceId) {
    throw new Error('No voice ID provided for audio generation');
  }

  try {
    const response = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.8,
          style: 0.4,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API error response:', errorText);
      
      if (response.status === 429) {
        throw new Error('quota_exceeded: ElevenLabs API quota exceeded');
      } else if (response.status === 401) {
        throw new Error('ElevenLabs API authentication failed');
      } else if (response.status === 422) {
        throw new Error('ElevenLabs API validation error: Invalid voice ID or text');
      } else {
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      }
    }

    const audioBuffer = await response.arrayBuffer();
    if (audioBuffer.byteLength === 0) {
      throw new Error('Empty audio response from ElevenLabs API');
    }

    return Buffer.from(audioBuffer).toString('base64');
  } catch (error) {
    console.error('Error in generateSingleAudio:', error);
    throw error;
  }
}