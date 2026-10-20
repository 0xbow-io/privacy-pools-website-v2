import { ScrollView, View, Platform } from 'react-native';
import { Header } from '@/components/ui/header';
import { Footer } from '@/components/ui/footer';
import { Transactions } from '@/components/pools/transactions';

export default function TransactionsScreen() {
  return (
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow px-[20px] py-[20px]">
        <View className="mx-auto w-full max-w-[1100px] grow gap-[20px]">
          <Transactions mode="full" />
          {Platform.OS === 'web' && <Footer />}
        </View>
      </ScrollView>
      {Platform.OS !== 'web' && (
        <View className="px-[20px] pb-[20px]">
          <Footer />
        </View>
      )}
    </View>
  );
}
