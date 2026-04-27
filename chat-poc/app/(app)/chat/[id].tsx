import { useEffect, useRef, useState } from 'react';
import {
  Button,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};

type TypingState = {
  user_id: string;
  draft: string;
  updated_at: number;
};

const TYPING_TTL_MS = 4000;
const BROADCAST_THROTTLE_MS = 50;

export default function ChatScreen() {
  const { id: conversationId } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const me = session!.user.id;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [peerTyping, setPeerTyping] = useState<Record<string, TypingState>>({});

  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastBroadcastRef = useRef(0);

  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(100);
      if (!cancelled && !error && data) setMessages(data as Message[]);
    })();

    const channel = supabase.channel(`conversation:${conversationId}`, {
      config: {
        private: true,
        broadcast: { self: false },
        presence: { key: me },
      },
    });

    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => {
        const m = payload.new as Message;
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m]
        );
      }
    );

    channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
      const t = payload as TypingState;
      if (t.user_id === me) return;
      setPeerTyping((prev) => ({ ...prev, [t.user_id]: t }));
    });

    channel.on('presence', { event: 'sync' }, () => {
      // Optional: derive online peers from channel.presenceState()
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ online_at: new Date().toISOString() });
      }
    });

    channelRef.current = channel;

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [conversationId, me]);

  useEffect(() => {
    const interval = setInterval(() => {
      setPeerTyping((prev) => {
        const now = Date.now();
        const next: Record<string, TypingState> = {};
        for (const [uid, t] of Object.entries(prev)) {
          if (now - t.updated_at < TYPING_TTL_MS && t.draft.length > 0) {
            next[uid] = t;
          }
        }
        return next;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  function onChangeText(next: string) {
    setInput(next);

    const now = Date.now();
    if (now - lastBroadcastRef.current < BROADCAST_THROTTLE_MS) return;
    lastBroadcastRef.current = now;

    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: {
        user_id: me,
        draft: next,
        updated_at: now,
      } satisfies TypingState,
    });
  }

  async function send() {
    const content = input.trim();
    if (!content) return;
    setInput('');

    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: me, draft: '', updated_at: Date.now() },
    });

    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: me,
      content,
    });
    if (error) console.warn('send failed', error.message);
  }

  const typingPeers = Object.values(peerTyping).filter((t) => t.draft.length > 0);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const mine = item.sender_id === me;
          return (
            <View
              style={[
                styles.bubble,
                mine ? styles.bubbleMine : styles.bubbleTheirs,
              ]}
            >
              <Text style={mine ? styles.textMine : styles.textTheirs}>
                {item.content}
              </Text>
            </View>
          );
        }}
      />

      {typingPeers.map((t) => (
        <View key={t.user_id} style={styles.draftBubble}>
          <Text style={styles.draftText}>{t.draft}</Text>
        </View>
      ))}

      <View style={styles.composer}>
        <TextInput
          value={input}
          onChangeText={onChangeText}
          placeholder="Message…"
          style={styles.composerInput}
        />
        <Button title="Send" onPress={send} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12 },
  bubble: {
    padding: 10,
    borderRadius: 14,
    marginVertical: 3,
    maxWidth: '80%',
  },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: '#3478f6' },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#e5e5ea' },
  textMine: { color: '#fff' },
  textTheirs: { color: '#000' },
  draftBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#f0f0f0',
    padding: 10,
    borderRadius: 14,
    marginHorizontal: 12,
    marginBottom: 4,
    opacity: 0.7,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: '#bbb',
  },
  draftText: { color: '#444', fontStyle: 'italic' },
  composer: {
    flexDirection: 'row',
    padding: 8,
    gap: 8,
    alignItems: 'center',
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
});
