import { useEffect, useState } from 'react';
import { Alert, Button, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

type Conv = {
  id: string;
  title: string | null;
  last_message_at: string;
  other: { username: string; display_name: string | null } | null;
};

export default function Inbox() {
  const { session } = useAuth();
  const [convs, setConvs] = useState<Conv[]>([]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select(
          `id, title, last_message_at,
           conversation_members!inner ( user_id, profiles ( username, display_name ) )`
        )
        .order('last_message_at', { ascending: false });

      if (cancelled) return;
      if (error) {
        Alert.alert('Failed to load chats', error.message);
        return;
      }

      const cleaned: Conv[] = (data ?? []).map((c: any) => {
        const others = c.conversation_members.filter(
          (m: any) => m.user_id !== session.user.id
        );
        return {
          id: c.id,
          title: c.title,
          last_message_at: c.last_message_at,
          other: others[0]?.profiles ?? null,
        };
      });
      setConvs(cleaned);
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.headerEmail}>{session?.user.email}</Text>
        <Button title="Sign out" onPress={() => supabase.auth.signOut()} />
      </View>
      <FlatList
        data={convs}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No conversations yet. Create one in SQL or build a "new chat" UI.
          </Text>
        }
        renderItem={({ item }) => (
          <Link href={`/chat/${item.id}`} asChild>
            <Pressable style={styles.row}>
              <Text style={styles.rowTitle}>
                {item.title ?? item.other?.display_name ?? item.other?.username ?? 'Chat'}
              </Text>
              <Text style={styles.rowMeta}>
                {new Date(item.last_message_at).toLocaleString()}
              </Text>
            </Pressable>
          </Link>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  headerEmail: { color: '#666', fontSize: 12 },
  row: { padding: 16, borderBottomWidth: 1, borderColor: '#eee' },
  rowTitle: { fontWeight: '600' },
  rowMeta: { color: '#666', fontSize: 12 },
  empty: { padding: 24, color: '#666', textAlign: 'center' },
});
