import { useState } from 'react';
import { Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '@/lib/supabase';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) Alert.alert('Sign in failed', error.message);
  }

  async function signUp() {
    setBusy(true);
    const { error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      Alert.alert('Sign up failed', error.message);
    } else {
      Alert.alert(
        'Account created',
        'If email confirmation is on, check your inbox. Otherwise sign in below.'
      );
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Chat PoC</Text>
      <TextInput
        placeholder="email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={styles.input}
      />
      <TextInput
        placeholder="password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={styles.input}
      />
      <Button title="Sign in" onPress={signIn} disabled={busy} />
      <Button title="Create account" onPress={signUp} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { padding: 24, gap: 12, marginTop: 80 },
  title: { fontSize: 24, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 12,
    borderRadius: 8,
  },
});
