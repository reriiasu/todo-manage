# todo-manage

[Share Todo](https://github.com/reriiasu/share-todo/)のサーバーサイドプログラムです。

毎日00時00分にDynamoDBを操作します。

## DynamoDB操作内容

1. Todoが期限切れを起こして7日過ぎたものに削除フラグを立てる
2. 1.の場合に繰り返しかつ、未完了項目を新規Todoとして作成
3. 削除フラグかつ、7日更新の無いアイテムを削除

## Installation

1. AWS SAM CLI のインストール

    [こちら(AWS SAM CLI のインストール)](https://docs.aws.amazon.com/ja_jp/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)を参照してください。

1. template.yamlのテーブル名をShareTodoのものに修正する

    ```yaml
        Environment:
            Variables:
            # Table名(DynamoDBのテーブル名を入力)
            tableName: Todo-xxxxxxxxxxxxxxxxxxxx
    ```

1. build

    ```shell
    $ sam build
    ```

1. Deploy

    ```shell
    $ sam deploy --guided
    ```