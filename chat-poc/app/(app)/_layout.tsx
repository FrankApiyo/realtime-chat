import { Stack } from 'expo-router';

export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Chats' }} />
      <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
    </Stack>
  );
}
